// @effect-diagnostics nodeBuiltinImport:off - Deploy tooling runs wrangler and prints to the terminal.
// @effect-diagnostics globalConsole:off - CLI output for the person running it.
/**
 * ViewCode Quick connect setup.
 *
 *   node scripts/viewcode-relay.ts deploy   [--mode desktop|web] [--name NAME] [--rotate-secret]
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

import {
  DEFAULT_WORKER_NAME,
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
  console.log("Signing in to Cloudflare (a browser window opens)...");
  const login = wrangler(["login"]);
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
    console.log(`\nQuick connect is set up: ${url}`);
    console.log(
      "Open ViewCode, Connect phone, Anywhere, and scan the QR code with the T3 Code app.",
    );
    console.log(
      "Keep in mind: the relay is your own Worker, and it (and any network inspection) can see the traffic.",
    );
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
    "Usage: node scripts/viewcode-relay.ts <deploy|remove> [--mode desktop|web] [--name NAME] [--rotate-secret] [--local-only]",
  );
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
