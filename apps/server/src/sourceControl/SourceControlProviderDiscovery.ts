import * as NodeUtil from "node:util";
import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  VcsError,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";

import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: VcsProcess.VcsProcessOutput["exitCode"];
}

export interface SourceControlUnknownRemoteRefinementInput {
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
  readonly auth: SourceControlAuthProbeInput;
}

interface SourceControlDiscoverySpecBase {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly installHint: string;
}

export type SourceControlCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "cli";
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly authArgs: ReadonlyArray<string>;
  readonly remoteRefinementArgs?: ReadonlyArray<string>;
  readonly probeTimeoutMs?: number;
  /**
   * True when the probe's answer does not depend on the working directory, so one result
   * serves every repository. `gh auth status --json hosts` lists all hosts and is
   * cwd-independent; a spec whose probe inspects the repository must leave this false.
   */
  readonly authProbeIsGlobal?: boolean;
  readonly parseAuth: (input: SourceControlAuthProbeInput) => SourceControlProviderAuth;
  readonly refineUnknownRemote?: (
    input: SourceControlUnknownRemoteRefinementInput,
  ) => SourceControlProviderInfo | null;
};

export type SourceControlApiDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "api";
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
};

export type SourceControlManagedCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "managed-cli";
  readonly probe: (cwd: string) => Effect.Effect<SourceControlProviderDiscoveryItem>;
  readonly refineUnknownRemote: (input: {
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<SourceControlProviderInfo | null>;
};

export type SourceControlProviderDiscoverySpec =
  | SourceControlCliDiscoverySpec
  | SourceControlManagedCliDiscoverySpec
  | SourceControlApiDiscoverySpec;

type SourceControlCliRemoteRefinementSpec = SourceControlCliDiscoverySpec & {
  readonly refineUnknownRemote: NonNullable<SourceControlCliDiscoverySpec["refineUnknownRemote"]>;
};

// Most provider CLIs answer `--version` in well under a second, so a short budget keeps
// discovery snappy. Specs whose CLI is known to be slower can raise it via probeTimeoutMs.
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function probeTimeoutMs(spec: SourceControlCliDiscoverySpec): number {
  return spec.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
}

const GLOBAL_AUTH_PROBE_CAPACITY = 16;
const GLOBAL_AUTH_PROBE_SUCCESS_TTL = Duration.seconds(60);
const GLOBAL_AUTH_PROBE_FAILURE_TTL = Duration.seconds(10);

interface DiscoveryProbeResult {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly executable: string;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

export function firstNonEmptyLine(text: string): Option.Option<string> {
  const line = NodeUtil.stripVTControlCharacters(text)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? Option.none() : Option.some(line);
}

export function detailFromCause(cause: unknown): Option.Option<string> {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return Option.some(cause.message.trim());
  }
  return Option.none();
}

function authAccount(account: string | undefined): Option.Option<string> {
  const trimmed = account?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authHost(host: string | undefined): Option.Option<string> {
  const trimmed = host?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authDetail(detail: string | undefined): Option.Option<string> {
  const trimmed = detail?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

export function providerAuth(input: {
  readonly status: SourceControlProviderAuth["status"];
  readonly account?: string | undefined;
  readonly host?: string | undefined;
  readonly detail?: string | undefined;
}): SourceControlProviderAuth {
  return {
    status: input.status,
    account: authAccount(input.account),
    host: authHost(input.host),
    detail: authDetail(input.detail),
  };
}

function unknownAuth(detail?: string): SourceControlProviderAuth {
  return providerAuth({ status: "unknown", detail });
}

export function combinedAuthOutput(input: SourceControlAuthProbeInput): string {
  const parts: string[] = [];
  for (const entry of [input.stdout, input.stderr]) {
    if (entry.trim().length > 0) {
      parts.push(entry);
    }
  }
  return parts.join("\n");
}

function sanitizedAuthLines(text: string): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const entry of text.split(/\r?\n/)) {
    const line = entry.trim();
    if (line.length === 0) continue;
    if (/^[-\s]*token(?:\s+scopes?)?:/iu.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

export function firstSafeAuthLine(text: string): string | undefined {
  return sanitizedAuthLines(text)[0];
}

export function parseCliHost(text: string): string | undefined {
  return sanitizedAuthLines(text)
    .map((line) => line.replace(/^[^a-z0-9]+/iu, ""))
    .find((line) => /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/iu.test(line));
}

/**
 * The host name a CLI's auth listing is compared on. Remote URLs keep their port (an SSH clone
 * on `:2222`, a web server on `:8443`) while CLIs usually record the bare host, so both sides
 * drop it.
 */
export function cliHostName(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/u, "");
}

export function matchFirst(text: string, patterns: ReadonlyArray<RegExp>): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function isCliRemoteRefinementSpec(
  spec: SourceControlProviderDiscoverySpec,
): spec is SourceControlCliRemoteRefinementSpec {
  return spec.type === "cli" && spec.refineUnknownRemote !== undefined;
}

function probeCli(input: {
  readonly spec: SourceControlCliDiscoverySpec;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
}): Effect.Effect<DiscoveryProbeResult> {
  return input.process
    .run({
      operation: "source-control.discovery.probe",
      command: input.spec.executable,
      args: input.spec.versionArgs,
      cwd: input.cwd,
      timeoutMs: probeTimeoutMs(input.spec),
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map(
        (result) =>
          ({
            kind: input.spec.kind,
            label: input.spec.label,
            executable: input.spec.executable,
            status: "available" as const,
            version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
              firstNonEmptyLine(result.stderr),
            ),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
          }) satisfies DiscoveryProbeResult,
      ),
      Effect.catch((cause) =>
        Effect.succeed({
          kind: input.spec.kind,
          label: input.spec.label,
          executable: input.spec.executable,
          status: "missing" as const,
          version: Option.none<string>(),
          installHint: input.spec.installHint,
          detail: detailFromCause(cause),
        } satisfies DiscoveryProbeResult),
      ),
    );
}

export function probeSourceControlProvider(input: {
  readonly spec: SourceControlProviderDiscoverySpec;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
  if (input.spec.type === "managed-cli") return input.spec.probe(input.cwd);
  if (input.spec.type === "api") {
    return input.spec.probeAuth.pipe(
      Effect.map(
        (auth) =>
          ({
            kind: input.spec.kind,
            label: input.spec.label,
            status: "available" as const,
            version: Option.none<string>(),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
            auth,
          }) satisfies SourceControlProviderDiscoveryItem,
      ),
    );
  }

  const spec = input.spec;

  return probeCli({
    spec,
    process: input.process,
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((item) => {
      if (item.status !== "available") {
        return Effect.succeed({
          ...item,
          auth: unknownAuth("Hosting integration command was not found on the server PATH."),
        } satisfies SourceControlProviderDiscoveryItem);
      }

      return input.process
        .run({
          operation: "source-control.discovery.auth",
          command: spec.executable,
          args: spec.authArgs,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: probeTimeoutMs(spec),
          maxOutputBytes: 8_000,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map(
            (result) =>
              ({
                ...item,
                auth: spec.parseAuth(result),
              }) satisfies SourceControlProviderDiscoveryItem,
          ),
          Effect.catch((cause) =>
            Effect.succeed({
              ...item,
              auth: unknownAuth(Option.getOrUndefined(detailFromCause(cause))),
            } satisfies SourceControlProviderDiscoveryItem),
          ),
        );
    }),
  );
}

function remoteRefinementArgs(spec: SourceControlCliDiscoverySpec): ReadonlyArray<string> {
  return spec.remoteRefinementArgs ?? spec.authArgs;
}

/**
 * A global probe is identified by its command line alone. The cwd rides along so whichever
 * caller starts the probe runs it in its own repository, but it never enters equality, so
 * every repository shares one entry.
 */
class GlobalAuthProbe implements Equal.Equal {
  readonly id: string;
  readonly spec: SourceControlCliDiscoverySpec;
  readonly cwd: string;

  constructor(spec: SourceControlCliDiscoverySpec, cwd: string) {
    this.id = [spec.executable, ...remoteRefinementArgs(spec)].join("\0");
    this.spec = spec;
    this.cwd = cwd;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof GlobalAuthProbe && that.id === this.id;
  }

  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

export interface SourceControlDiscoveryProbes {
  /**
   * Runs a CLI spec's remote-refinement probe. A spec with `authProbeIsGlobal` runs once for
   * every repository: concurrent callers join the in-flight probe and its result is reused for
   * a minute (ten seconds after a failure). An interrupted caller leaves the probe running for
   * the callers still waiting on it, and an interrupted probe is never cached.
   */
  readonly refineUnknownRemote: (
    spec: SourceControlCliDiscoverySpec,
    cwd: string,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
  /** Forgets every remembered answer, for a rescan the user asked for. */
  readonly reset: Effect.Effect<void>;
}

export const makeSourceControlDiscoveryProbes = Effect.fn("makeSourceControlDiscoveryProbes")(
  function* (process: VcsProcess.VcsProcess["Service"]) {
    const run = (spec: SourceControlCliDiscoverySpec, cwd: string) =>
      process.run({
        operation: "source-control.discovery.refine-unknown-remote",
        command: spec.executable,
        args: remoteRefinementArgs(spec),
        cwd,
        allowNonZeroExit: true,
        timeoutMs: probeTimeoutMs(spec),
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      });

    const globalProbes = yield* Cache.makeWith(
      (probe: GlobalAuthProbe) => run(probe.spec, probe.cwd),
      {
        capacity: GLOBAL_AUTH_PROBE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? GLOBAL_AUTH_PROBE_SUCCESS_TTL : GLOBAL_AUTH_PROBE_FAILURE_TTL,
      },
    );

    return {
      refineUnknownRemote: (spec, cwd) =>
        spec.authProbeIsGlobal === true
          ? Cache.get(globalProbes, new GlobalAuthProbe(spec, cwd))
          : run(spec, cwd),
      reset: Cache.invalidateAll(globalProbes),
    } satisfies SourceControlDiscoveryProbes;
  },
);

export const refineUnknownRemoteProvider = Effect.fn("refineUnknownRemoteProvider")(
  function* (input: {
    readonly specs: ReadonlyArray<SourceControlProviderDiscoverySpec>;
    readonly probes: SourceControlDiscoveryProbes;
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext | null;
  }): Effect.fn.Return<SourceControlProvider.SourceControlProviderContext | null> {
    if (input.context === null || input.context.provider.kind !== "unknown") {
      return input.context;
    }
    const context = input.context;

    const providers = yield* Effect.forEach(input.specs, (spec) => {
      if (spec.type === "managed-cli") {
        return spec.refineUnknownRemote({ cwd: input.cwd, context });
      }
      if (!isCliRemoteRefinementSpec(spec)) return Effect.succeed(null);
      return input.probes.refineUnknownRemote(spec, input.cwd).pipe(
        Effect.map((auth) =>
          spec.refineUnknownRemote({
            cwd: input.cwd,
            context,
            auth,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    });
    const provider = providers.find((candidate) => candidate !== null);

    return provider ? { ...context, provider } : context;
  },
);
