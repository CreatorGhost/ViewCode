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
- `scripts/viewcode-relay.ts`: `deploy` and `remove`.

## Set up

```bash
node scripts/viewcode-relay.ts deploy      # or: ./build.sh --relay
```

1. Signs in with `npx wrangler login --device` if `wrangler whoami` says nobody
   is. The device flow (RFC 8628) has no localhost callback: open the link
   wrangler shows and enter the code, in any browser. (The callback flow fails
   with "No CSRF value available in the session cookie" when it is finished in a
   browser other than the default one.)
2. Deploys the Worker (default name `viewcode-relay`; `--name` to change it). A
   Cloudflare account with no workers.dev subdomain makes wrangler ask to
   register one, answer no when it has no terminal, and fail; the script
   recognises that and tells you to open dash.cloudflare.com, Workers & Pages,
   once to create it.
3. Generates the host secret and sets it as the Worker secret `HOST_SECRET`
   through stdin. The secret is never printed.
4. Writes the Worker address to `viewcodeRelay.url` in `settings.json`
   (`"enabled": true`) and the secret to `secrets/viewcode-relay-host-secret.bin`
   (mode 0600) in the same data folder `build.sh` resolves for `--managed`. The
   Worker's name is kept in `viewcode-relay.json` there so `remove` can find it.

5. Ends with a reachability probe: one HTTPS request to the new address with the
   operating system's certificate store, 10s timeout. Any HTTP answer passes (the
   Worker answers `503 ViewCode on your computer isn't connected right now.`
   until the app connects). A reset, TLS error or timeout prints that this
   computer can't reach the address and that the network blocked it; the config is
   still saved, but the script does not say Quick connect "is set up".

`node scripts/viewcode-relay.ts check` runs just that probe against the stored
address and exits 1 when it fails.

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
- `npx wrangler tail viewcode-relay` shows the Worker's logs. The Worker logs no
  bodies or headers.

## Status meanings

| Status         | Meaning                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `off`          | Set up but switched off, or not set up.                                                                                               |
| `connecting`   | First attempt in progress.                                                                                                            |
| `reconnecting` | Lost or cannot reach the relay; retrying with jittered backoff from 1s up to 30s.                                                     |
| `auth-failed`  | The relay answered 401. Retrying cannot help; run `deploy` again (or `--rotate-secret`).                                              |
| `blocked`      | Three attempts in a row were stopped by the network: an untrusted certificate issuer, or a connection reset during the TLS handshake. |
| `connected`    | The socket is up; the QR is shown.                                                                                                    |

`blocked` keeps retrying every 30s at most; it clears the moment the network lets a
connection through. DNS failures, timeouts and 5xx answers stay `reconnecting`.
The reason names the cause: "an untrusted certificate intercepted it" or "the
network reset the connection to the relay".

- **Untrusted certificate.** The corporate root certificate needs to be in the
  operating system's trust store. The desktop app's backend is started with
  `--use-system-ca` (`DesktopBackendConfiguration.ts`); for `npx t3`, set
  `NODE_OPTIONS=--use-system-ca`.
- **Reset at the Client Hello.** Some firewalls reset the TLS handshake for every
  `*.workers.dev` subdomain by SNI while the apex `workers.dev` is allowed. The
  symptom is `curl: (35) Recv failure: Connection reset by peer` and Node
  `ECONNRESET`, even though the system certificate store is fine. Confirm with
  `curl -sv https://<relay>/`: the reset comes right after "Client hello", before
  any certificate. The fix is an allowance from whoever runs the network (ask IT
  to allow the relay's address); the app does not work around it. Same Wi-Fi
  still works, and Quick connect works on networks that don't block it.

T3 Connect is a different path: `relay.t3.codes` only brokers sign-in and
environment links, and phone traffic runs through a Cloudflare tunnel
(`cloudflared` to Cloudflare's argotunnel), which this kind of network blocks
too. See [T3 Connect](../internals/t3-connect.md).

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
