# Quick connect relay

Runbook for ViewCode's Quick connect: an outbound WebSocket from the ViewCode
server to a Cloudflare Worker the user owns. Users read
[Remote access](../user/remote-access.md#quick-connect); this page is for whoever
sets it up, debugs it or removes it.

## Pieces

- `infra/viewcode-relay/`: the Worker. One Durable Object per deployment holds the
  host's WebSocket and multiplexes phone requests over it. Deployed with wrangler
  to `https://<name>.<account>.workers.dev`.
- `packages/shared/src/viewcodeRelayProtocol.ts`: the frame format both ends use.
- `apps/server/src/relay/`: the connector (`ViewCodeRelayConnector.ts`), the
  forwarder that serves requests against the server's own port or Unix socket
  (`relayForwarder.ts`), the status logic (`viewCodeRelayHealth.ts`), and the
  in-app setup (`ViewCodeRelaySetup.ts`, `wranglerRunner.ts`, `relayWorkerSource.ts`).
- `packages/shared/src/viewcodeRelaySetup.ts`: wrangler-output parsing, redaction and
  probe classification, shared by the app and the script.
- `scripts/viewcode-relay.ts`: `deploy`, `check` and `remove` from a terminal.

## Set up

Users set it up in the app (**Connect phone → Anywhere → Quick connect → Connect with
Cloudflare**); see [Remote access](../user/remote-access.md#quick-connect). The server
runs the same steps as the script, one operation at a time, and pushes progress on the
auth access stream as `viewcodeRelaySetup` (only to sessions with `access:write`, the
scope its RPCs require, because it carries the sign-in code):

1. Finds `npx` on the server's PATH and checks `node --version` (22 or newer;
   `--use-system-ca` is added to `NODE_OPTIONS` from 22.15, older Node runs with the
   bundled roots). No Node: "Quick connect setup needs Node.js".
2. Stages the Worker in a temporary folder: the sources from `infra/` in a checkout, or
   the copy the server build puts in `apps/server/dist/viewcode-relay-worker/`, which
   ships in the desktop app and the npm package. A generated `wrangler.json` points the
   `@t3tools/shared/viewcodeRelayProtocol` import at the local copy (`alias`), so
   wrangler bundles it at deploy time without `node_modules`.
3. `wrangler whoami`; if nobody is signed in, `wrangler login --device --browser=false`.
   The link and code are parsed from its output and shown in the app (the desktop app
   opens the link); if parsing fails, its lines are shown verbatim.
4. `wrangler deploy --name <name>` (the name remembered in `viewcode-relay.json`, else
   `viewcode-relay`). Output mentioning a missing workers.dev subdomain stops at
   "needs subdomain" with nothing saved; **Continue** (or returning to the window after
   **Open Cloudflare**) deploys again.
5. Generates the host secret unless one is stored (rotation only on request) and sets
   it with `wrangler secret put HOST_SECRET` through stdin. Only then are the secret
   (`secrets/viewcode-relay-host-secret.bin`, 0600), `viewcode-relay.json` and
   `viewcodeRelay: { enabled: true, url }` in `settings.json` written.
6. Verifies with `GET /__viewcode/host` and the secret. Only the Worker's `426` counts as
   set up. Resets and TLS failures ("network refused"), 401/403 ("credential rejected",
   three in a row) and DNS/timeouts/5xx ("transient") are retried after 5, 10, 20, 40s
   and then every minute for about ten minutes. After that it reports "unreachable" and
   keeps the settings, so the connector keeps retrying.

Wrangler output is redacted (the host secret) before it is kept or shown, and is never
logged. Cancel interrupts the operation, which kills the wrangler child it spawned.

From a terminal the script does the same with the terminal attached:

```bash
node scripts/viewcode-relay.ts deploy      # or: ./build.sh --relay
```

It writes the files directly in the data folder `build.sh` resolves for `--managed`,
fetches the address once, and says "set up" only if it answered. `check` runs only that
probe. The probe loads the system store with `tls.setDefaultCACertificates`; on a Node
without that API it falls back to the bundled roots and a TLS-inspecting proxy will fail
it. Running `deploy` again is safe: it keeps the existing secret; `--rotate-secret`
makes a new one. `--mode web` targets the dev/web data folder instead of the desktop
app's.

## Remove

In the app: the **⋯** menu, **Remove Quick connect**. From a terminal:

```bash
node scripts/viewcode-relay.ts remove
```

Both delete the Worker (`wrangler delete --name <name> --force`, signing in first if
needed), then the stored secret, `viewcode-relay.json` and the `viewcodeRelay` settings.
If the delete fails (not signed in, offline) nothing local is changed, so it can be
retried; "Remove from this computer only" (`--local-only`) clears only this computer's
settings and leaves the Worker on the account.

## Check it

- **Connect phone → Anywhere → Quick connect** shows the state: connecting,
  reconnecting (with the reason), blocked, auth failed, or connected with a code.
- With the host disconnected, the Worker answers `503 ViewCode on your computer
isn't connected right now.` to every request.
- `curl -i https://<worker>/__viewcode/host` answers `401` (no secret) and never
  reveals anything else. `426` with the right bearer secret means the secret
  matches and only the WebSocket upgrade is missing.
- `t3 pair --relay` mints a code for the relay origin
  (`https://<relay>/pair#token=…`) instead of the LAN address.
- `npx wrangler tail viewcode-relay` shows the Worker's logs. The Worker logs no
  bodies or headers.

## Status meanings

| Status         | Meaning                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `off`          | Set up but switched off, or not set up.                                                                   |
| `connecting`   | First attempt in progress.                                                                                |
| `reconnecting` | Lost or cannot reach the relay; retrying with jittered backoff from 1s up to 30s. Never stops on a reset. |
| `auth-failed`  | The relay answered 401. Retrying cannot help; redeploy with a new secret.                                 |
| `blocked`      | Three attempts in a row ended at a certificate issuer this computer does not trust.                       |
| `connected`    | The socket is up; the QR is shown.                                                                        |

`blocked` keeps retrying every 30s at most; it clears the moment the network lets a
connection through. Fix it by having the corporate root certificate in the operating
system's trust store. The desktop app's backend is started with `--use-system-ca`
(`DesktopBackendConfiguration.ts`); for `npx t3`, set `NODE_OPTIONS=--use-system-ca`.

A brand-new relay address can be reset by a corporate firewall for up to about an
hour while it is categorised, then work unchanged. Resets are therefore never
terminal: the connector keeps retrying, and after five failures in a row the note
changes to "still connecting — a newly created relay address can take up to an hour
to start working, and some networks block it; Same Wi-Fi still works."

## Compression

The forwarder asks the local server for `accept-encoding: identity`, so the relay
always carries uncompressed bodies and the Cloudflare edge is the only layer that
compresses. Forwarding the client's Accept-Encoding made the server send brotli,
and the edge then relabelled `content-encoding` to the phone's preference without
transcoding, so pages arrived undecodable (blank `GET /`).

## Limits

- One host per Worker. A new host connection replaces the old one.
- Request and response bodies stream in chunks of at most 256 KiB, with 1 MiB
  in flight per stream. Individual WebSocket messages must stay under 1 MiB (the
  Durable Object limit).
- The relay's response to a phone WebSocket is sent before the computer accepts
  it, so a refused connection shows up as an immediate close, not an HTTP error.
- Cloudflare's free plan applies (Workers and SQLite-backed Durable Objects).
  Requests count against it; the idle host socket does not, because the ping is
  answered without waking the object.

## Not tested from a source checkout

Deploying (from the app or the script), the real Cloudflare Durable Object behaviour and behaviour behind a
particular company's proxy need a real account and network. Verify after the
first deploy: pair a phone, use it for a few minutes on mobile data, put the
computer to sleep and wake it, and confirm it reconnects without a new code.
