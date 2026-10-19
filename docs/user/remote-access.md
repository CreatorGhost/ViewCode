# Remote access

Connect a phone, browser, or another desktop app to ViewCode running on a different
machine. That machine must stay running and reachable while you work.

## Connect your phone

Use a ViewCode mobile build that speaks the same protocol as your server.
See [ViewCode Android app](./android-app.md) for Android installation.
Your phone needs no account. On the computer, choose **Connect phone** (sidebar
footer, command palette, or the top of **Settings → Connections**), pick how the
phone will reach it, and scan the code from the app's **Add environment**.

- **Anywhere · Quick connect.** The recommended way to reach the computer over the
  internet, including on networks where tunnels are blocked. See
  [Quick connect](#quick-connect).
- **Same Wi-Fi.** Choose **Turn on and restart** if asked; ViewCode restarts once
  and reopens on the code. Works only on the same network.
- **Anywhere · Tailscale.** Shown only when Tailscale is installed on this computer.
  **Turn on Tailscale** enables Tailscale HTTPS and restarts once. Works wherever your
  phone is on your tailnet; phones still have to pair. To have the desktop app turn
  Tailscale HTTPS on by itself at launch whenever Tailscale is signed in, turn on
  **Turn on Tailscale phone access at launch** in **Settings → Connections**.

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
- **Several accounts.** If your sign-in reaches more than one Cloudflare
  account, ViewCode asks which one should hold the relay and keeps using it for
  redeploys and removal.
- **workers.dev address.** A new Cloudflare account has no `workers.dev`
  address yet. ViewCode creates a free one for you (`viewcode-` and a few random
  characters). If that is not possible, ViewCode asks you to choose one under
  **Workers & Pages** instead and continues when you come back.
- **Node.js.** The desktop app needs nothing else: the first time, it gets
  Cloudflare's tools ready on its own (a Node.js 22 or newer you installed is
  used instead). With an npm installation, setup uses the Node.js that runs ViewCode; if
  it is missing, ViewCode says so and links to nodejs.org.

When the relay answers, the code for your phone appears; scan it with the ViewCode app. On some company networks a brand-new relay address is blocked for a few
minutes up to an hour. ViewCode then says it is waiting for the network; you can
close the dialog, and it connects on its own once the address is allowed.

The **⋯** menu on the Quick connect tab turns it off, redeploys the relay (the
secret is kept unless you choose **Redeploy with a new secret**), or removes it.
**Remove Quick connect** deletes the relay from your Cloudflare account and
forgets it on this computer; if Cloudflare can't be reached, you can remove it
from this computer only.

What can see your traffic: the relay is **not** end-to-end encrypted. The phone app does not add its own encryption, so your Cloudflare Worker sees the
requests it forwards, and so does any TLS-inspecting firewall between the
computer or phone and Cloudflare. Nobody else can connect: every request still
needs the phone to be paired with a code from this computer.

Check your company's policy on remote-access tools before using Quick connect on
a work computer.

If the network's certificate is not trusted by the computer, ViewCode says so and
keeps trying. The desktop app already trusts the operating system's certificate
store; when running `npx viewcode-app` yourself, start it with
`NODE_OPTIONS=--use-system-ca`. More in the
[Quick connect runbook](../operations/viewcode-relay.md).

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, [Connect phone](#connect-your-phone) turns on network access
and shows a code. For another desktop or a browser, open **Settings →
Connections**, enable **Network access**, then create a pairing link using an
address the other device can reach. Changing network access restarts the
desktop app. You can turn it off in the same place.

With network access and Tailscale Serve off, the desktop app opens no network
port at all: its local server listens on a private socket that only your user
account can reach. That is also why `viewcode pair` reports that such a server cannot
be paired until network access is on.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
viewcode serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
viewcode pair
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

### Reach one machine several ways

A machine can have more than one route, such as LAN, Tailscale or Quick connect.
To add one, choose **Add route** in the machine's route list. Pairing the same machine again over another
address also adds a route instead of a second machine. A new route is placed by
speed, in that order. On web and desktop you can reorder routes at any time.

While connected through a paired address, ViewCode also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once over Tailscale or Quick connect is enough to use the
LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. A learned route cannot be removed; it goes away with the route it was learned through, or when the machine stops
reporting that address.

ViewCode connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, ViewCode checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** to
see its routes and the one in use, or remove one. Removing a route leaves other
ways to reach that machine saved.

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
viewcode serve --tailscale-serve
```

For an already-running server:

```bash
viewcode pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `viewcode pair --help` for other pairing options.

#### Turning Tailscale off

ViewCode runs the `tailscale` command only when you use a Tailscale feature: Tailscale
HTTPS, the Connect phone Tailscale option, or opening a file in your editor over
Tailscale SSH from another machine. Where security software stops apps that run
Tailscale, turn off **Tailscale** in **Settings → Connections**, or start ViewCode with
`VIEWCODE_DISABLE_TAILSCALE=1` to turn it off for that computer whatever the setting
says. Tailscale features then say they are off instead of running it.

### HTTPS web clients

A web client served over HTTPS needs an HTTPS endpoint for a remote server. A
pairing link does not make an unreachable backend reachable or convert HTTP to
HTTPS. For a plain HTTP LAN endpoint, use the direct URL from a browser that can
open it, or pair from the desktop app. Include `https://` when entering an HTTPS
address on mobile.

## SSH hosts

Install and start ViewCode yourself on the remote machine, then pair with its
reachable address. You can also forward its port with your usual SSH tools.
Provider CLIs and credentials belong on that host.

Automatic installation of the upstream managed SSH runtime is disabled in
ViewCode. To use desktop-managed SSH with a server you installed yourself, set
`T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH` in the desktop app's environment to that
server's absolute JavaScript entry path on the remote host, then restart the app.
The remote host also needs the supported Node.js version. Without an explicit
entry, use manual installation and direct pairing or your own SSH port forward.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the ViewCode home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo viewcode browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx viewcode-app browser setup`, and keeps your `PATH` when Node is installed only
for your user. For a bundled desktop build, it can name the full path of its own server
entry instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `T3CODE_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents ViewCode did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `viewcode auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx viewcode-app pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx viewcode-app auth pairing create` and `npx viewcode-app auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance and access management
can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

If a connection fails, check the host is awake, the server is running, and the
other device can reach the paired address. Check the date and time on both devices.
For server version warnings, follow [Updating ViewCode](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. ViewCode restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through paired remote environments.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
