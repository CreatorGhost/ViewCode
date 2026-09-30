// @effect-diagnostics nodeBuiltinImport:off - Deploy tooling runs wrangler and prints to the terminal.
// @effect-diagnostics globalConsole:off - CLI output for the person running it.
// @effect-diagnostics globalTimers:off globalFetch:off - Plain-node reachability probe, not Effect.
/**
 * ViewCode Quick connect setup.
 *
 *   node scripts/viewcode-relay.ts deploy   [--mode desktop|web] [--name NAME] [--rotate-secret]
 *   node scripts/viewcode-relay.ts check    [--mode desktop|web]
 *   node scripts/viewcode-relay.ts remove   [--mode desktop|web] [--local-only]
 *
 * `deploy` puts a small Worker on YOUR Cloudflare account (workers.dev),
 * generates the secret this computer uses to connect to it, and stores the
 * Worker's address and that secret where ViewCode reads them. It never prints
 * the secret. `remove` deletes the Worker and clears the stored settings.
 *
 * The data folder is resolved exactly as `build.sh` does (`--managed` writes
 * settings.json in the same place), so the running app picks the change up.
 * Wrangler runs through npx, with the OS certificate store trusted so a
 * TLS-inspecting corporate proxy does not break it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { RELAY_HOST_PATH } from "@t3tools/shared/viewcodeRelayProtocol";

import {
  DEFAULT_WORKER_NAME,
  describeFetchError,
  detectMissingWorkersDevSubdomain,
  formatMissingSubdomain,
  formatReachableSetup,
  formatUnreachable,
  generateHostSecret,
  isValidWorkerName,
  parseWorkerUrl,
  readRelayState,
  readSecretFile,
  readSettingsFile,
  removeRelayState,
  removeSecretFile,
  withoutRelaySettings,
  withRelaySettings,
  wranglerNeedsLogin,
  writeRelayState,
  writeSecretFile,
  writeSettingsFile,
} from "./lib/viewcode-relay.ts";
import { resolveBuildState } from "./lib/build-state.ts";

/** How long the reachability probe waits before calling the origin unreachable. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Fetches the origin once to see whether this computer can reach it. Any HTTP
 * answer (even 401/503) means reachable; a reset, TLS failure or timeout means
 * not right now. The OS trust store is loaded first so a corporate proxy's
 * certificate is accepted (Node's global fetch reads the default CA set that
 * `setDefaultCACertificates` updates; on a Node too old for the API we fall
 * back to the bundled roots, noted in docs/operations/viewcode-relay.md).
 */
async function probeOrigin(
  origin: string,
): Promise<
  { readonly ok: true; readonly status: number } | { readonly ok: false; readonly detail: string }
> {
  try {
    NodeTls.setDefaultCACertificates(NodeTls.getCACertificates("system"));
  } catch {
    // Older Node without the system-CA helper: rely on the bundled roots.
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${RELAY_HOST_PATH}`, {
      redirect: "manual",
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, detail: describeFetchError(error) };
  } finally {
    clearTimeout(timer);
  }
}

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const wranglerConfig = NodePath.join(repoRoot, "infra/viewcode-relay/wrangler.jsonc");
const WRANGLER = "wrangler@4";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const wranglerEnv = {
  ...process.env,
  NODE_OPTIONS: `--use-system-ca${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ""}`,
};

/** Runs wrangler with the terminal attached, except stdin/stdout when captured. */
function wrangler(
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly capture?: boolean } = {},
) {
  return NodeChildProcess.spawnSync("npx", ["--yes", WRANGLER, ...args], {
    cwd: NodePath.join(repoRoot, "infra/viewcode-relay"),
    env: wranglerEnv,
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
    stdio: [
      options.input === undefined ? "inherit" : "pipe",
      options.capture ? "pipe" : "inherit",
      options.capture ? "pipe" : "inherit",
    ],
  });
}

function ensureLoggedIn(): void {
  const whoami = wrangler(["whoami"], { capture: true });
  if (!wranglerNeedsLogin(`${whoami.stdout ?? ""}${whoami.stderr ?? ""}`, whoami.status ?? 1))
    return;
  // Device flow (RFC 8628): wrangler prints a URL and a code instead of opening
  // a browser itself, so sign-in works from any browser on any machine — the
  // point on a locked-down computer where the default flow cannot pop a window.
  console.log(
    "Signing in to Cloudflare: open the link wrangler shows and enter the code, in any browser.",
  );
  const login = wrangler(["login", "--device"]);
  if (login.status !== 0) fail("Cloudflare sign-in did not complete.");
}

function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const mode = flag(rest, "--mode") ?? "desktop";
  if (mode !== "desktop" && mode !== "web") fail("--mode must be desktop or web.");
  const { stateDir } = await resolveBuildState({ mode, repoRoot });
  const settingsFile = NodePath.join(stateDir, "settings.json");

  if (command === "deploy") {
    const name = flag(rest, "--name") ?? readRelayState(stateDir)?.name ?? DEFAULT_WORKER_NAME;
    if (!isValidWorkerName(name))
      fail(`"${name}" is not a valid Worker name (lowercase letters, digits, dashes).`);
    // Fail on an unreadable settings file before changing anything on Cloudflare.
    const settings = readSettingsFile(settingsFile);

    ensureLoggedIn();
    console.log(`Deploying the relay Worker "${name}" to your Cloudflare account...`);
    const deploy = wrangler(["deploy", "--config", wranglerConfig, "--name", name], {
      capture: true,
    });
    const deployOutput = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
    if (deploy.status !== 0) fail(`Deploy failed:\n${deployOutput}`);
    const url = parseWorkerUrl(deployOutput, name);
    if (url === null) {
      if (detectMissingWorkersDevSubdomain(deployOutput))
        fail(formatMissingSubdomain(settingsFile));
      fail(
        `Deployed, but the workers.dev address was not in wrangler's output. Find it in the Cloudflare dashboard (Workers, ${name}), then set "viewcodeRelay": { "enabled": true, "url": "<address>" } in ${settingsFile}.`,
      );
    }

    const rotate = rest.includes("--rotate-secret");
    const secret = (!rotate && readSecretFile(stateDir)) || generateHostSecret();
    // Through stdin, so the secret never appears in a process list or in output.
    const put = wrangler(
      ["secret", "put", "HOST_SECRET", "--name", name, "--config", wranglerConfig],
      {
        input: `${secret}\n`,
        capture: true,
      },
    );
    if (put.status !== 0) fail("Setting the Worker's secret failed. Run the command again.");

    // Secret first: the settings write is what the running server reacts to.
    writeSecretFile(stateDir, secret);
    writeRelayState(stateDir, { name, url });
    writeSettingsFile(settingsFile, withRelaySettings(settings, url));

    // Confirm the origin actually answers from here before claiming success. A
    // reset/TLS/timeout is not proof the relay is broken (a fresh workers.dev
    // address can take time, and this network may block it), so be honest and
    // still keep the saved config; the server keeps retrying regardless.
    console.log(`\nDeployed. Checking that this computer can reach ${url}...`);
    const probe = await probeOrigin(url);
    console.log("");
    console.log(probe.ok ? formatReachableSetup(url) : formatUnreachable(url, probe.detail));
    return;
  }

  if (command === "check") {
    const state = readRelayState(stateDir);
    const url = state?.url;
    if (url === undefined || url === "") {
      fail("Quick connect is not set up here. Run `node scripts/viewcode-relay.ts deploy` first.");
    }
    console.log(`Checking that this computer can reach ${url}...`);
    const probe = await probeOrigin(url);
    if (probe.ok) {
      console.log(`Reachable: ${url} answered (HTTP ${probe.status}).`);
      return;
    }
    console.log(formatUnreachable(url, probe.detail));
    return;
  }

  if (command === "remove") {
    const state = readRelayState(stateDir);
    const localOnly = rest.includes("--local-only");
    if (state && !localOnly) {
      ensureLoggedIn();
      console.log(`Deleting the relay Worker "${state.name}"...`);
      const removal = wrangler([
        "delete",
        "--config",
        wranglerConfig,
        "--name",
        state.name,
        "--force",
      ]);
      if (removal.status !== 0) {
        fail(
          "Could not delete the Worker. Nothing was changed here. Retry, or use --local-only to only clear this computer's settings.",
        );
      }
    }
    writeSettingsFile(settingsFile, withoutRelaySettings(readSettingsFile(settingsFile)));
    removeSecretFile(stateDir);
    removeRelayState(stateDir);
    console.log("Quick connect is removed.");
    return;
  }

  fail(
    "Usage: node scripts/viewcode-relay.ts <deploy|check|remove> [--mode desktop|web] [--name NAME] [--rotate-secret] [--local-only]",
  );
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
