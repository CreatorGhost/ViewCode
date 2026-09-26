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

step "Checking tools"
command -v git >/dev/null || { echo "git is not installed." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 24.13+ is required: https://nodejs.org" >&2; exit 1; }
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 24 ]; then
  echo "Node.js $(node -v) found; ViewCode needs 24.13 or newer." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null; then
  echo "Enabling pnpm through corepack"
  corepack enable
fi

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
pnpm install --frozen-lockfile

if [ "$mode" = web ]; then
  step "Starting server + web UI (Ctrl+C to stop)"
  exec pnpm dev
fi

step "Building the desktop app"
pnpm build:desktop

step "Opening ViewCode (close the window or press Ctrl+C to quit)"
exec pnpm start:desktop
