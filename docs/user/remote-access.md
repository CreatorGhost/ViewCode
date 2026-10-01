# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## Connect your phone

Install **T3 Code** from the App Store or Google Play (it works with ViewCode), or
build the [ViewCode Android app](./android-app.md).
Your phone needs no account. On the computer, choose **Connect phone** (sidebar
footer, command palette, or the top of **Settings → Connections**), pick how the
phone will reach it, and scan the code from the app's **Add environment**.

- **Anywhere · Quick connect.** The recommended way to reach the computer over the
  internet, including on networks where tunnels are blocked. See
  [Quick connect](#quick-connect).
- **Same Wi-Fi.** Choose **Turn on and restart** if asked; ViewCode restarts once
  and reopens on the code. Works only on the same network.
- **Anywhere · Tailscale.** Shown only when Tailscale is installed on this computer. **Turn on Tailscale** enables
  Tailscale HTTPS and restarts once. Works wherever your phone is on your tailnet.
  **Settings → Connections** can turn it on at every launch; that is off by
  default because some security software stops Tailscale.

Each code works once for five minutes; choose **New code** for another phone. Keep
the computer awake and ViewCode running. **Turn off local network access** in the
dialog restarts ViewCode with no network port again. Phones you already paired
stay listed under **Settings → Connections → Authorized clients**, where you can
revoke them.

## Quick connect

Quick connect lets your phone reach this computer over the internet without a
tunnel or an open port. ViewCode connects **out** to a small relay that runs on
your own Cloudflare account, and the phone reaches the computer through it. It
uses ordinary HTTPS to a `workers.dev` address, so it usually works on corporate
networks that block tunnels. You pair once; the phone keeps the same address and
reconnects on its own.

Set it up once from the app: open **Connect phone → Anywhere → Quick connect**
(or **Set up** next to Quick connect in **Settings → Connections**) and choose
**Connect with Cloudflare**.

- **Account.** You need a Cloudflare account; the free plan is enough. If you
  don't have one, choose **Create one free**, sign up, then come back and choose
  **Connect with Cloudflare** again. ViewCode never creates accounts or shares
  one between people.
- **Sign in.** A Cloudflare page opens (on the desktop app) with a code shown in
  ViewCode. Check that the codes match and approve. If no page opened, use the
  link and code shown. Setup then continues on its own.
- **workers.dev address.** A new Cloudflare account may first need a free
  `workers.dev` address. ViewCode says so: choose **Open Cloudflare**, pick one
  under **Workers & Pages**, then come back; setup continues when you return.
- **Needs Node.js.** Setup runs Cloudflare's tools through Node.js 22 or newer.
  If it is missing, ViewCode says so and links to nodejs.org.

When the relay answers, the code for your phone appears; scan it with the T3 Code
app. On some company networks a brand-new relay address is blocked for a few
minutes up to an hour. ViewCode then says it is waiting for the network; you can
close the dialog, and it connects on its own once the address is allowed.

The **⋯** menu on the Quick connect tab turns it off, redeploys the relay (the
secret is kept unless you choose **Redeploy with a new secret**), or removes it.
**Remove Quick connect** deletes the relay from your Cloudflare account and
forgets it on this computer; if Cloudflare can't be reached, you can remove it
from this computer only.

What can see your traffic: the relay is **not** end-to-end encrypted. The T3
Code phone app can't add its own encryption, so your Cloudflare Worker sees the
requests it forwards, and so does any TLS-inspecting firewall between the
computer or phone and Cloudflare. Nobody else can connect: every request still
needs the phone to be paired with a code from this computer.

Check your company's policy on remote-access tools before using Quick connect on
a work computer.

If the network's certificate is not trusted by the computer, ViewCode says so and
keeps trying. The desktop app already trusts the operating system's certificate
store; when running `npx t3` yourself, start it with
`NODE_OPTIONS=--use-system-ca`. More in the
[Quick connect runbook](../operations/viewcode-relay.md).

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. ViewCode's Connect phone dialog does not offer it; use
[Quick connect](#quick-connect) instead. Builds with T3 Connect configuration can
still manage it in **Settings → Connections**.

For a command-line host, run:

```bash
t3 connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, [Connect phone](#connect-your-phone) turns on network access
and shows a code. For another desktop or a browser, open **Settings →
Connections**, enable **Network access**, then create a pairing link using an
address the other device can reach. Changing network access restarts the
desktop app. You can turn it off in the same place.

With network access and Tailscale Serve off, the desktop app opens no network
port at all: its local server listens on a private socket that only your user
account can reach. That is also why `t3 pair` reports that such a server cannot
be paired until network access is on.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart T3 Code on the host.                                                                         |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                            |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating T3 Code](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
