import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { cursorAgentPromptAuthProblem, cursorAgentPromptFailure } from "./cursorAgentAcpSupport.ts";
import { checkCursorAgentProviderStatus } from "./cursorAgentStatus.ts";

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

/** Runs `cursor-agent about` as a Node one-liner that prints the given reply. */
const check = (reply: AboutReply, hasSavedLogin: boolean) =>
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
      () => Effect.succeed(MODELS),
      Effect.succeed(hasSavedLogin),
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
});
