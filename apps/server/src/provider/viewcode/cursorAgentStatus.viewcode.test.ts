import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  CursorAgentModelDiscoveryError,
  CursorAgentStalledError,
  cursorAgentPromptAuthProblem,
  cursorAgentPromptFailure,
} from "./cursorAgentAcpSupport.ts";
import {
  checkCursorAgentProviderStatus,
  MODEL_DISCOVERY_RETRY_DELAY,
} from "./cursorAgentStatus.ts";

const settings: CursorSettings = { enabled: true, customModels: [] };
const MODELS = [
  {
    slug: "default",
    name: "Auto",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

interface AboutReply {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
}

type DiscoverModels = () => Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  CursorAgentModelDiscoveryError
>;

/** Runs `cursor-agent about` as a Node one-liner that prints the given reply. */
const check = (
  reply: AboutReply,
  hasSavedLogin: boolean,
  models: {
    readonly discover?: DiscoverModels;
    readonly lastKnown?: ReadonlyArray<ServerProviderModel>;
  } = {},
) =>
  Effect.gen(function* () {
    const live = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "about") {
        return Effect.die("Only `cursor-agent about` may run in a status check.");
      }
      const script = `process.stdout.write(${JSON.stringify(reply.stdout)});process.stderr.write(${JSON.stringify(reply.stderr ?? "")});process.exitCode=${reply.code ?? 0};`;
      return live.spawn(
        ChildProcess.make(process.execPath, ["-e", script], { ...command.options, shell: false }),
      );
    });
    return yield* checkCursorAgentProviderStatus(
      settings,
      {},
      models.discover ?? (() => Effect.succeed(MODELS)),
      Effect.succeed(hasSavedLogin),
      Effect.succeed(models.lastKnown ?? []),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Platform, "darwin"),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const NOT_LOGGED_IN = JSON.stringify({ cliVersion: "2026.10.01", userEmail: null });
const SIGNED_IN = JSON.stringify({ cliVersion: "2026.10.01", userEmail: "dev@example.test" });

describe("Cursor CLI sign-in status after sleep", () => {
  it.effect("does not call a saved login that the CLI could not confirm signed out", () =>
    Effect.gen(function* () {
      const afterWake = yield* check({ stdout: NOT_LOGGED_IN }, true);
      assert.equal(afterWake.auth.status, "unknown");
      assert.equal(afterWake.status, "warning");
      assert.include(afterWake.message ?? "", "Keychain");
      assert.notInclude(afterWake.message ?? "", "is not signed in");

      // Nothing is cached in the check: the next one reads the CLI again and recovers.
      const later = yield* check({ stdout: SIGNED_IN }, true);
      assert.equal(later.auth.status, "authenticated");
      assert.equal(later.auth.email, "dev@example.test");
    }),
  );

  it.effect("still reports a genuinely missing login as signed out", () =>
    Effect.gen(function* () {
      const signedOut = yield* check({ stdout: NOT_LOGGED_IN }, false);
      assert.equal(signedOut.auth.status, "unauthenticated");
      assert.equal(signedOut.status, "error");
      assert.include(signedOut.message ?? "", "cursor-agent login");

      const textForm = yield* check(
        { stdout: "CLI Version         2026.03.20\nUser Email          Not logged in\n" },
        false,
      );
      assert.equal(textForm.auth.status, "unauthenticated");
    }),
  );

  it.effect("classifies a Keychain or network failure as unreadable, not signed out", () =>
    Effect.gen(function* () {
      const keychain = yield* check(
        {
          stdout: NOT_LOGGED_IN,
          stderr: "SecItemCopyMatching failed: User interaction is not allowed. (-25308)",
          code: 1,
        },
        false,
      );
      assert.equal(keychain.auth.status, "unknown");
      assert.equal(keychain.status, "warning");

      const offline = yield* check(
        { stdout: NOT_LOGGED_IN, stderr: "getaddrinfo ENOTFOUND api2.cursor.sh", code: 1 },
        false,
      );
      assert.equal(offline.auth.status, "unknown");
    }),
  );
});

/** A model list that fails `failures` times, then lists `MODELS`; `failed` settles at the first failure. */
const flakyDiscovery = (failures: number, failed: Deferred.Deferred<void>) => {
  let calls = 0;
  const discover: DiscoverModels = () =>
    Effect.suspend(() => {
      calls += 1;
      return calls > failures
        ? Effect.succeed(MODELS)
        : Deferred.succeed(failed, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new CursorAgentModelDiscoveryError({ cause: "fetch failed: ECONNRESET" }),
              ),
            ),
          );
    });
  return { discover, calls: () => calls };
};

const OTHER_MODELS = [{ ...MODELS[0]!, slug: "gpt-5.4", name: "GPT-5.4" }];

describe("Cursor CLI model list after sleep", () => {
  it.effect("retries a failed model list once, after a backoff", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const discovery = flakyDiscovery(1, failed);
      const checking = yield* check({ stdout: SIGNED_IN }, true, {
        discover: discovery.discover,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(failed);
      yield* TestClock.adjust(MODEL_DISCOVERY_RETRY_DELAY);
      const result = yield* Fiber.join(checking);

      assert.equal(discovery.calls(), 2);
      assert.equal(result.status, "ready");
      assert.include(
        result.models.map((model) => model.slug),
        "default",
      );
      assert.isUndefined(result.message);
    }),
  );

  it.effect("keeps the last model list when the refresh cannot reach Cursor", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const discovery = flakyDiscovery(Number.POSITIVE_INFINITY, failed);
      const checking = yield* check({ stdout: SIGNED_IN }, true, {
        discover: discovery.discover,
        lastKnown: OTHER_MODELS,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(failed);
      yield* TestClock.adjust(MODEL_DISCOVERY_RETRY_DELAY);
      const result = yield* Fiber.join(checking);

      assert.equal(discovery.calls(), 2);
      assert.equal(result.status, "warning");
      assert.include(
        result.models.map((model) => model.slug),
        "gpt-5.4",
      );
      assert.equal(result.message, "Couldn't reach Cursor to list models; will retry.");
      // `about` read a current, signed-in CLI: an update would not help.
      assert.notInclude(result.message ?? "", "update");
    }),
  );
});

describe("Cursor CLI turn failures", () => {
  const failure = (message: string) =>
    EffectAcpErrors.AcpRequestError.internalError(message) as unknown;

  it("tells signed out, unreadable credentials and network apart", () => {
    assert.equal(
      cursorAgentPromptAuthProblem(
        failure("Authentication required. Please run 'cursor-agent login' first."),
      ),
      "signed-out",
    );
    // A real agent's JSON-RPC error can reach the adapter as a plain Error.
    assert.equal(
      cursorAgentPromptAuthProblem(new Error("Not logged in. Run `agent login`.")),
      "signed-out",
    );
    assert.equal(
      cursorAgentPromptAuthProblem(failure("Could not read from the macOS keychain")),
      "credentials-unreadable",
    );
    assert.equal(cursorAgentPromptAuthProblem(failure("fetch failed: ECONNRESET")), "network");
    assert.isUndefined(cursorAgentPromptAuthProblem(failure("Model gpt-x is not available")));
  });

  it("says the next message starts a fresh CLI instead of only asking for a login", () => {
    const signedOut = cursorAgentPromptFailure(
      failure("Authentication required. Please run 'cursor-agent login' first."),
    );
    assert.include(signedOut.message, "next message starts a fresh one");
    assert.include(signedOut.message, "cursor-agent status");
    assert.isTrue(signedOut.retryable === true);

    const keychain = cursorAgentPromptFailure(failure("keychain is locked"));
    assert.include(keychain.message, "Keychain is locked");

    const other = cursorAgentPromptFailure(failure("Model gpt-x is not available"));
    assert.notInclude(other.message, "fresh one");
  });

  it("says Cursor stopped responding for a stall or a lost connection, not for an exit", () => {
    const stalled = cursorAgentPromptFailure(
      new EffectAcpErrors.AcpTransportError({
        method: "session/prompt",
        cause: new CursorAgentStalledError({ idleSeconds: 600 }),
      }),
    );
    assert.equal(stalled.message, "Cursor stopped responding; send it again.");
    assert.equal(
      cursorAgentPromptFailure(new EffectAcpErrors.AcpInputStreamEndedError({})).message,
      "Cursor stopped responding; send it again.",
    );
    const exited = cursorAgentPromptFailure(
      new EffectAcpErrors.AcpProcessExitedError({ code: 1, stderr: "panic: boom" }),
    );
    assert.notEqual(exited.message, "Cursor stopped responding; send it again.");
  });
});
