import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT = Duration.millis(1_500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

// tailscale is a real executable everywhere (`tailscale.exe` on Windows), so
// it is always spawned directly, with its arguments as an array, rather than
// through a shell. Install paths with spaces need no quoting.
const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

// Windows environment names are case-insensitive, but a copied env object is not.
const readEnvironmentValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key]?.trim();
  return value ? value : undefined;
};

/**
 * Where installers put the CLI, for when it is not on PATH: apps launched from
 * the desktop often get a short PATH, and the Mac app never adds one. Only these
 * fixed paths are ever tried; nothing else on the machine is searched.
 */
export function knownTailscaleExecutablePaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
      ];
    case "linux":
      return [
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
        "/usr/local/bin/tailscale",
        "/snap/bin/tailscale",
      ];
    case "win32":
      return ["ProgramFiles", "ProgramFiles(x86)"].flatMap((name) => {
        const directory = readEnvironmentValue(env, name);
        return directory ? [`${directory.replace(/[\\/]+$/, "")}\\Tailscale\\tailscale.exe`] : [];
      });
    default:
      return [];
  }
}

/**
 * The CLI to run: the PATH name when `isAvailable` finds it there, otherwise
 * the first known install path that exists and is executable, otherwise null.
 * `isAvailable` takes either form; callers pass a filesystem-only check.
 */
export const findTailscaleExecutable = Effect.fnUntraced(function* <R>(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isAvailable: (command: string) => Effect.Effect<boolean, never, R>;
}): Effect.fn.Return<string | null, never, R> {
  for (const command of [
    tailscaleCommandForPlatform(input.platform),
    ...knownTailscaleExecutablePaths(input.platform, input.env),
  ]) {
    if (yield* input.isAvailable(command)) return command;
  }
  return null;
});

interface TailscaleCommandTarget {
  readonly executable: string;
  readonly subcommand: "status" | "serve";
  readonly argumentCount: number;
}

const TailscaleCommandContext = {
  executable: Schema.String,
  subcommand: Schema.Literals(["status", "serve"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

/** Classifies stderr into a safe label, dropping the text itself. */
const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedError<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

class TailscaleCommandOutputError extends Schema.TaggedError<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedError<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    // A classified diagnostic, never raw CLI output. `tailscale` prints auth
    // keys and node identifiers into stderr, and this field is surfaced in
    // dev-runner logs — so it carries only a known-safe label from the closed
    // set below. Callers that need to recognize a specific failure (e.g.
    // `serve off` on a port with no mapping) match on the label.
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedError<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export type TailscaleCommandError =
  | TailscaleCommandSpawnError
  | TailscaleCommandOutputError
  | TailscaleCommandExitError
  | TailscaleCommandTimeoutError;

export class TailscaleStatusParseError extends Schema.TaggedError<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export const parseTailscaleMagicDnsName = (
  rawStatusJson: string,
): Effect.Effect<string | null, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map(normalizeMagicDnsName),
  );

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
      };
    }),
  );

/**
 * Spawns the CLI by its PATH name and, when PATH has none, tries each known
 * install path in turn. A missing path fails to spawn, so nothing is probed
 * first. When none starts, the PATH failure is the one reported.
 */
const spawnTailscale = Effect.fnUntraced(function* (
  subcommand: "status" | "serve",
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const spawnAs = (executable: string) => {
    const commandContext: TailscaleCommandTarget = {
      executable,
      subcommand,
      argumentCount: args.length,
    };
    return spawner.spawn(ChildProcess.make(executable, args)).pipe(
      Effect.map((child) => ({ child, commandContext })),
      Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
      // Spawning can also fail as a defect rather than a typed error - a
      // non-directory entry on PATH makes node throw ENOTDIR synchronously.
      // `mapError` never sees that, so it would escape as an uncaught error.
      Effect.catchDefect((cause) =>
        Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
      ),
    );
  };
  const onPath = yield* Effect.result(spawnAs(tailscaleCommandForPlatform(platform)));
  if (Result.isSuccess(onPath)) return onPath.success;
  if (isNotFoundSpawnError(onPath.failure)) {
    for (const executable of knownTailscaleExecutablePaths(platform, env)) {
      const installed = yield* Effect.result(spawnAs(executable));
      if (Result.isSuccess(installed)) return installed.success;
    }
  }
  return yield* onPath.failure;
});

const isNotFoundSpawnError = (error: TailscaleCommandSpawnError): boolean => {
  const cause = error.cause as { readonly reason?: { readonly _tag?: unknown } } | undefined;
  return cause?.reason?._tag === "NotFound";
};

export const readTailscaleStatus = Effect.gen(function* () {
  const args = ["status", "--json"];
  // Becomes the executable that started, for the errors after the spawn.
  let commandContext: TailscaleCommandTarget = {
    executable: tailscaleCommandForPlatform(yield* HostProcessPlatform),
    subcommand: "status",
    argumentCount: args.length,
  };
  return yield* Effect.gen(function* () {
    const spawned = yield* spawnTailscale("status", args);
    commandContext = spawned.commandContext;
    const child = spawned.child;
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStdout(child.stdout),
        collectStderr(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      return yield* new TailscaleCommandExitError({
        ...commandContext,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
      });
    }
    return yield* parseTailscaleStatus(stdout);
  }).pipe(
    Effect.scoped,
    Effect.timeout(TAILSCALE_STATUS_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TailscaleCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(TAILSCALE_STATUS_TIMEOUT),
            cause,
          }),
        ),
    }),
  );
});

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    // Becomes the executable that started, for the errors after the spawn.
    let commandContext: TailscaleCommandTarget = {
      executable: tailscaleCommandForPlatform(yield* HostProcessPlatform),
      subcommand: "serve",
      argumentCount: args.length,
    };
    const timeout = Duration.fromInputUnsafe(timeoutInput);
    return yield* Effect.gen(function* () {
      const spawned = yield* spawnTailscale("serve", args);
      commandContext = spawned.commandContext;
      const child = spawned.child;
      const [stderr, exitCode] = yield* Effect.all(
        [collectStderr(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
      );
      if (exitCode !== 0) {
        return yield* new TailscaleCommandExitError({
          ...commandContext,
          exitCode,
          stderrLength: stderr.length,
          ...(stderrDiagnosticOf(stderr) !== undefined
            ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
            : {}),
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new TailscaleCommandTimeoutError({
              ...commandContext,
              timeoutMs: Duration.toMillis(timeout),
              cause,
            }),
          ),
      }),
    );
  });

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
}): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const args = ["serve", "--bg", `--https=${servePort}`, `http://${localHost}:${input.localPort}`];
  return runTailscaleCommand(args, TAILSCALE_SERVE_TIMEOUT);
};

export const disableTailscaleServe = (
  input: {
    readonly servePort?: number;
  } = {},
): Effect.Effect<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    return yield* runTailscaleCommand(
      ["serve", `--https=${servePort}`, "off"],
      TAILSCALE_SERVE_TIMEOUT,
    );
  });

export const probeTailscaleHttpsEndpoint = (input: {
  readonly baseUrl: string;
  readonly timeout?: Duration.Input;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const request = HttpClientRequest.get(url.toString());
      return yield* client.execute(request);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.match(response, {
      onNone: () => false,
      onSome: (httpResponse) => httpResponse.status >= 200 && httpResponse.status < 300,
    });
  }).pipe(Effect.orElseSucceed(() => false));
