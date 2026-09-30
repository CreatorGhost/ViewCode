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
  (`relayForwarder.ts`), and the status logic (`viewCodeRelayHealth.ts`).
- `scripts/viewcode-relay.ts`: `deploy`, `check` and `remove`.

## Set up

```bash
node scripts/viewcode-relay.ts deploy      # or: ./build.sh --relay
```

1. Signs in with `npx wrangler login --device` if `wrangler whoami` says nobody is:
   open the link wrangler shows and enter the code, in any browser.
2. Deploys the Worker (default name `viewcode-relay`; `--name` to change it).
3. Generates the host secret and sets it as the Worker secret `HOST_SECRET`
   through stdin. The secret is never printed.
4. Writes the Worker address to `viewcodeRelay.url` in `settings.json`
   (`"enabled": true`) and the secret to `secrets/viewcode-relay-host-secret.bin`
   (mode 0600) in the same data folder `build.sh` resolves for `--managed`. The
   Worker's name is kept in `viewcode-relay.json` there so `remove` can find it.
5. Fetches the new address once (10s, OS certificate store trusted). Any HTTP
   answer means reachable and only then does it say "set up". A reset, TLS error
   or timeout prints "deployed but this computer can't reach it right now"; the
   settings are still saved and it exits 0.

If the account has no workers.dev subdomain, wrangler deploys a Worker with no
address (non-interactively it declines to create one). `deploy` says so: create
the subdomain in the Cloudflare dashboard (Workers & Pages, workers.dev), then
run `deploy` again.

`node scripts/viewcode-relay.ts check` runs only the reachability probe against
the stored address. The probe loads the system store with
`tls.setDefaultCACertificates`; on a Node without that API it falls back to the
bundled roots and a TLS-inspecting proxy will fail it.

Running `deploy` again is safe: it redeploys the code and keeps the existing
secret. `--rotate-secret` makes a new one. `--mode web` targets the dev/web data
folder instead of the desktop app's.

## Remove

```bash
node scripts/viewcode-relay.ts remove
```

Deletes the Worker, the stored secret and the `viewcodeRelay` settings. If the
delete fails (not signed in, offline) nothing local is changed, so it can be
retried; `--local-only` clears only this computer's settings.

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
| `auth-failed`  | The relay answered 401. Retrying cannot help; run `deploy` again (or `--rotate-secret`).                  |
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

Deploying, the real Cloudflare Durable Object behaviour and behaviour behind a
particular company's proxy need a real account and network. Verify after the
first deploy: pair a phone, use it for a few minutes on mobile data, put the
computer to sleep and wake it, and confirm it reconnects without a new code.
