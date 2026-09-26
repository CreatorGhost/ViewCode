#!/usr/bin/env bash
# Pull the latest ViewCode, build the desktop app and open it.
#
#   ./build.sh            pull, install, build, open the desktop app
#   ./build.sh --no-pull  build what is checked out
#   ./build.sh --web      run server + web UI in dev mode instead (open the printed URL)
#   ./build.sh --managed  for locked-down machines: chooses Claude and Cursor
#                         (the onboarding provider choice is marked made), so
#                         ViewCode never launches Codex, OpenCode, Grok,
#                         Antigravity or Command Code
#                         (docs/operations/managed-mode-plan.md)
#   ./build.sh --fresh    start as a brand-new install: moves your ViewCode data
#                         (~/.viewcode) and the desktop app's profile aside, with a
#                         timestamp, so onboarding and the provider picker show again.
#                         Nothing is deleted; the script prints how to restore.
#                         Refuses to run while ViewCode is open.
#
# Run from anywhere; it works in the folder this script lives in.
set -euo pipefail

cd "$(dirname "$0")"

pull=1
mode=desktop
managed=0
fresh=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    --web) mode=web ;;
    --managed) managed=1 ;;
    --fresh) fresh=1 ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=13)?0:1)'
}

# --fresh must inspect the actual target directories before any setup can move
# legacy tools out of them. Prefer an already-installed private Node when the
# system Node is too old. An unavailable resolver is not evidence of idle data.
refuse_fresh_while_running() {
  if ! "$state_node" scripts/build-state.ts check "$mode"; then
    echo "Fresh reset refused; no data was moved. This check needs Node 24.13+ and installed repo dependencies." >&2
    exit 1
  fi
}
if [ "$fresh" = 1 ]; then
  state_node=$(command -v node || true)
  if ! node_ok; then
    state_node=$(ls -d "$HOME"/.viewcode-tools/node/node-v24.*/bin/node 2>/dev/null | tail -1 || true)
  fi
  [ -n "$state_node" ] || {
    echo "Cannot check fresh-reset targets without Node; install Node 24.13+ and repo dependencies first." >&2
    exit 1
  }
  refuse_fresh_while_running
fi

# Downloads Node 24 into ~/.viewcode-tools/node for ViewCode only; the system Node is untouched.
install_private_node() {
  local os arch ext dir base file sums
  case "$(uname -s)" in
    Darwin) os=darwin ext=tar.gz ;;
    Linux) os=linux ext=tar.xz ;;
    *) echo "Install Node.js 24.13+ from https://nodejs.org and run again." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "Unsupported CPU $(uname -m); install Node.js 24.13+ yourself." >&2; exit 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v24.x
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk -v s="-$os-$arch.$ext" 'index($2, s) { print $2; exit }')
  [ -n "$file" ] || { echo "Could not find a Node 24 download for $os-$arch." >&2; exit 1; }
  dir="$tools_dir/node/${file%.$ext}"
  if [ ! -x "$dir/bin/node" ]; then
    echo "Downloading $file (used only by ViewCode, into $tools_dir/node)"
    mkdir -p "$tools_dir/node"
    local tmp
    tmp=$(mktemp -d)
    curl -fL --progress-bar "$base/$file" -o "$tmp/$file"
    local want got
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')
    if command -v shasum >/dev/null; then got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}');
    else got=$(sha256sum "$tmp/$file" | awk '{print $1}'); fi
    [ "$want" = "$got" ] || { echo "Checksum mismatch for $file; aborting." >&2; rm -rf "$tmp"; exit 1; }
    tar -xf "$tmp/$file" -C "$tools_dir/node"
    rm -rf "$tmp"
  fi
  export PATH="$dir/bin:$PATH"
}

step "Checking tools"
# build.sh's own Node and pnpm live apart from ViewCode's data, so --fresh can
# move the data aside without pulling the tools out from under this script.
tools_dir="$HOME/.viewcode-tools"
if [ ! -d "$tools_dir" ]; then
  mkdir -p "$tools_dir"
  # Earlier versions kept them inside ~/.viewcode, or in a --fresh backup of it.
  for old in "$HOME/.viewcode" $(ls -d "$HOME"/.viewcode.bak-* 2>/dev/null | sort -r); do
    if [ -d "$old/node" ]; then
      mv "$old/node" "$tools_dir/node"
      [ -d "$old/bin" ] && mv "$old/bin" "$tools_dir/bin"
      break
    fi
  done
fi
command -v git >/dev/null || { echo "git is not installed." >&2; exit 1; }
if ! node_ok; then
  latest=$(ls -d "$tools_dir"/node/node-v24.*/bin 2>/dev/null | tail -1 || true)
  [ -n "$latest" ] && export PATH="$latest:$PATH"
  if ! node_ok; then
    echo "Node.js $(node -v 2>/dev/null || echo 'not found') is too old; ViewCode needs 24.13 or newer."
    install_private_node
  fi
fi
echo "Using Node.js $(node -v)"
# Trust the OS certificate store too, so installs work behind corporate TLS
# inspection (otherwise Node fails with SELF_SIGNED_CERT_IN_CHAIN).
export NODE_OPTIONS="--use-system-ca${NODE_OPTIONS:+ $NODE_OPTIONS}"
# pnpm comes from corepack in a private folder, so nothing global is changed.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
shims="$tools_dir/bin"
mkdir -p "$shims"
corepack enable --install-directory "$shims" pnpm
export PATH="$shims:$PATH"
echo "Using pnpm $(pnpm -v)"

if [ "$pull" = 1 ]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  step "Pulling the latest $branch"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "You have local changes. Commit or stash them, or run with --no-pull." >&2
    git status --short >&2
    exit 1
  fi
  git pull --ff-only origin "$branch"
fi
echo "At $(git log -1 --format='%h %s')"

step "Installing dependencies"
pnpm install --frozen-lockfile --config.confirmModulesPurge=false

# Use the launcher's env-file and worktree rules after pulling/installing too.
# Only these paths cross into the shell; credentials from .env stay private.
state_node=$(command -v node)
state_paths=$("$state_node" scripts/build-state.ts resolve "$mode")
base_dir=$(printf '%s\n' "$state_paths" | sed -n '1p')
state_dir=$(printf '%s\n' "$state_paths" | sed -n '2p')
profile_dir=$(printf '%s\n' "$state_paths" | sed -n '3p')

if [ "$fresh" = 1 ]; then
  step "Fresh start: moving existing ViewCode data aside"
  # Checked again: the install above takes a while.
  refuse_fresh_while_running
  stamp=$(date +%Y%m%d-%H%M%S)
  data_dir="$base_dir"
  for dir in "$data_dir" "$profile_dir"; do
    if [ -e "$dir" ]; then
      mv "$dir" "$dir.bak-$stamp"
      echo "Moved $dir -> $dir.bak-$stamp"
      echo "  restore: rm -rf \"$dir\" && mv \"$dir.bak-$stamp\" \"$dir\""
    fi
  done
fi

if [ "$managed" = 1 ]; then
  step "Managed mode: enabling only Claude and Cursor"
  # Merges into the settings the launched app reads; other settings are kept.
  settings_file="$state_dir/settings.json"
  SETTINGS_FILE="$settings_file" node -e '
    const fs = require("node:fs"), path = require("node:path");
    const file = process.env.SETTINGS_FILE;
    // Parsed as leniently as the server does (fromLenientJson in
    // packages/shared/src/schemaJson.ts): comments and trailing commas outside
    // strings are dropped. Anything still unparsable is left untouched.
    const lenient = (text) =>
      text
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) => (str ? m : ""))
        .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : ""))
        .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => (str ? m : (close ?? "")));
    let settings = {};
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      try { settings = JSON.parse(lenient(text)); }
      catch (error) {
        console.error("Cannot read " + file + " (" + error.message + "); fix or remove it first.");
        process.exit(1);
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        console.error("Cannot read " + file + " (not a JSON object); fix or remove it first.");
        process.exit(1);
      }
      if (lenient(text) !== text) console.log("Note: comments in " + file + " are not kept.");
    }
    const chosen = new Set(["claudeAgent", "cursor"]);
    const drivers = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "commandCode"];
    settings.providers = settings.providers ?? {};
    for (const driver of drivers)
      settings.providers[driver] = { ...settings.providers[driver], enabled: chosen.has(driver) };
    // Explicit provider instances (extra accounts) override providers.*, so
    // they follow their driver too; the envelope flag carries the choice.
    for (const instance of Object.values(settings.providerInstances ?? {})) {
      if (!instance || typeof instance !== "object") continue;
      instance.enabled = chosen.has(instance.driver);
      if (instance.config && typeof instance.config === "object") delete instance.config.enabled;
    }
    // The first-run provider choice is made: no picker, nothing else probed.
    settings.providerSelection = "chosen";
    settings.defaultAutoPull = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    console.log("Wrote " + file);
  '
fi

if [ "$mode" = web ]; then
  step "Starting server + web UI (Ctrl+C to stop)"
  exec pnpm dev
fi

step "Building the desktop app"
pnpm build:desktop

step "Opening ViewCode (close the window or press Ctrl+C to quit)"
exec pnpm start:desktop
