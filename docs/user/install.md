# Install ViewCode

ViewCode runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.
You need an installed, authenticated provider before starting a thread; you can
configure providers after opening ViewCode.

## ViewCode from npm

Use Node.js 24.13.1 or newer:

```sh
npm install -g viewcode-app
viewcode
```

`viewcode` starts the server and opens ViewCode in your browser. To try it without
a global install, run `npx viewcode-app@latest`.

If a new terminal cannot find `viewcode`, check `node --version` and the global
npm binary directory on your `PATH`. With nvm, choose an installed default, such
as `nvm alias default 24`.

On a company network that inspects TLS, add `export NODE_OPTIONS=--use-system-ca`
to your shell profile so Node trusts the certificates your company installed.
Enable only providers and remote-access tools your company allows. A
[company policy](#company-policy) takes precedence over choices made during setup
or in a project.

## Command line

| Task                                         | Command                              |
| -------------------------------------------- | ------------------------------------ |
| Start the server and open the web app        | `viewcode`                           |
| Start without opening a browser              | `viewcode serve`                     |
| Create a pairing link for a reachable server | `viewcode pair`                      |
| Show available commands                      | `viewcode --help`                    |
| Update the npm installation                  | `npm install -g viewcode-app@latest` |
| Remove the npm installation                  | `npm uninstall -g viewcode-app`      |

To open a project from a terminal, use an explicit path such as
`viewcode ./my-project`. A bare directory name is accepted only if it already
exists. If a server is already running, connect to it instead of starting another
against the same data directory. Use `--base-dir <path>` for an independent home.
The default home is `~/.viewcode`; runtime state is under its `userdata` directory.
An existing installation configured with another home keeps that location.

ViewCode does not offer the upstream standalone runtime installer, managed service
installation or CLI self-update. npm updates are manual; see [Updating ViewCode](./updating.md).
Removing the npm package leaves your data directory intact.

## Desktop app

Use a ViewCode desktop release from the
[ViewCode repository](https://github.com/CreatorGhost/ViewCode/releases), or build
from its source. Upstream T3 Code installers and package-manager entries install
a separate application.

A macOS build that is not notarized, including one you built yourself, may be
blocked the first time. Right-click it in Applications and choose **Open**, or use
**Open Anyway** in **System Settings → Privacy & Security**. For builds that cannot
install updates themselves, download the replacement ViewCode build and replace
the app in Applications.

The command-line installation above is separate from the desktop app. ViewCode
keeps the upstream Settings action for installing its command hidden.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects there.
Install provider CLIs inside that distro. The desktop app prepares its server
runtime there; the first launch after an app update can take longer.

### Open a project from a terminal

With the ViewCode desktop app already running on the same machine:

```sh
viewcode app
```

This opens a thread for the current directory, adding the project if needed.
Pass a path, such as `viewcode app ../my-project`, to open another directory.
A standalone server or an SSH session cannot open the local desktop app this way.

## Mobile app

Use a ViewCode mobile build that matches your server's orchestration protocol.
See [ViewCode Android app](./android-app.md) for Android build and installation.
Pair the phone with your server using [remote access](./remote-access.md).
The phone uses the server's provider installations and credentials.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider     | Install and authenticate                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex        | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude       | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor       | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build   | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode     | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity  | Install and sign in with Google from ViewCode's provider settings.                                                                                        |
| Command Code | Install [Command Code](https://commandcode.ai) (`npm i -g command-code`), then run `cmd login`.                                                           |
| Droid        | Install [Droid](https://docs.factory.ai/cli/getting-started/quickstart), then run `droid` and log in, or set `FACTORY_API_KEY`.                           |
| Devin        | Install the [Devin CLI](https://docs.devin.ai/cli), then run `devin auth login`, or set `WINDSURF_API_KEY`.                                               |
| Muse Code    | Install [Muse Code](https://dev.meta.ai/docs/muse-code), then run `muse login`.                                                                           |
| Pi           | Install [Pi](https://pi.dev) (`npm i -g @earendil-works/pi-coding-agent`), then run `pi` and use `/login`.                                                |

Provider CLIs must be on the server's `PATH`. If ViewCode cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

A new install starts with every provider off. The welcome screen asks which ones
you use and shows which CLIs it found, without running any of them; nothing starts
until you turn a provider on there or in **Settings → Providers**. Existing installs
keep their saved provider choices. A [company policy](#company-policy) can block
providers whatever you or a project choose.

ViewCode warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when ViewCode cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with ViewCode. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, ViewCode does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Droid](./providers-droid.md),
[Devin](./providers-devin.md), and [Pi](./providers-pi.md).

## Company policy

IT can block providers and Tailscale for everyone on a computer. A blocked provider
stays off whatever the user, a project or the welcome screen picks, never runs, and
shows as **Blocked by your organization**. Blocked Tailscale means ViewCode never
runs the `tailscale` command, and **Settings → Connections → Tailscale** shows it as
blocked. Deploy the policy, then restart ViewCode:

```json
{
  "providers": { "codex": { "allowed": false } },
  "tailscale": { "allowed": false }
}
```

| Platform | Where                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| macOS    | A device configuration profile with managed preferences for `dev.viewcode.app` (same keys) |
| Linux    | `/etc/viewcode/policy.json`                                                                |
| Windows  | `C:\ProgramData\ViewCode\policy.json`                                                      |

On macOS the profile must be installed for the device, not a single user: ViewCode
reads `/Library/Managed Preferences/dev.viewcode.app.plist`.

Provider keys are `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`,
`antigravity`, `commandCode`, `droid`, `devin`, `pi` and `muse`; `acpRegistry`
blocks every agent added from the ACP registry. Only `"allowed": false` blocks.
Users cannot lift the policy from settings or the environment. A policy file that
cannot be read is reported in the server log and blocks nothing.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating ViewCode](./updating.md): update the app and connected servers.
