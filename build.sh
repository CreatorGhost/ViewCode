#!/usr/bin/env bash
# Pull the latest ViewCode, build the desktop app and open it.
#
#   ./build.sh            pull, install, build, open the desktop app
#   ./build.sh --no-pull  build what is checked out
#   ./build.sh --web      run server + web UI in dev mode instead (open the printed URL)
#
# Run from anywhere; it works in the folder this script lives in.
set -euo pipefail

cd "$(dirname "$0")"

pull=1
mode=desktop
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    --web) mode=web ;;
    -h | --help)
      sed -n '2,8p' "$0"
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

# Downloads Node 24 into ~/.viewcode/node for ViewCode only; the system Node is untouched.
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
  dir="$HOME/.viewcode/node/${file%.$ext}"
  if [ ! -x "$dir/bin/node" ]; then
    echo "Downloading $file (used only by ViewCode, into ~/.viewcode/node)"
    mkdir -p "$HOME/.viewcode/node"
    local tmp
    tmp=$(mktemp -d)
    curl -fL --progress-bar "$base/$file" -o "$tmp/$file"
    local want got
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')
    if command -v shasum >/dev/null; then got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}');
    else got=$(sha256sum "$tmp/$file" | awk '{print $1}'); fi
    [ "$want" = "$got" ] || { echo "Checksum mismatch for $file; aborting." >&2; rm -rf "$tmp"; exit 1; }
    tar -xf "$tmp/$file" -C "$HOME/.viewcode/node"
    rm -rf "$tmp"
  fi
  export PATH="$dir/bin:$PATH"
}

step "Checking tools"
command -v git >/dev/null || { echo "git is not installed." >&2; exit 1; }
if ! node_ok; then
  latest=$(ls -d "$HOME"/.viewcode/node/node-v24.*/bin 2>/dev/null | tail -1 || true)
  [ -n "$latest" ] && export PATH="$latest:$PATH"
  if ! node_ok; then
    echo "Node.js $(node -v 2>/dev/null || echo 'not found') is too old; ViewCode needs 24.13 or newer."
    install_private_node
  fi
fi
echo "Using Node.js $(node -v)"
# pnpm comes from corepack in a private folder, so nothing global is changed.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
shims="$HOME/.viewcode/bin"
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

if [ "$mode" = web ]; then
  step "Starting server + web UI (Ctrl+C to stop)"
  exec pnpm dev
fi

step "Building the desktop app"
pnpm build:desktop

step "Opening ViewCode (close the window or press Ctrl+C to quit)"
exec pnpm start:desktop
