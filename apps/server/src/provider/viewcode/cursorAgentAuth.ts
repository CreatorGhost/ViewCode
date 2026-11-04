/**
 * Sign-in for the `cursor-agent` runtime is the CLI's own login, stored by the
 * CLI itself. ViewCode runs `cursor-agent login` in its in-app terminal when the
 * host has a PTY, and `cursor-agent logout` to sign out; the health check reads
 * the result with `cursor-agent about`. Both run only when the user asks.
 *
 * @module CursorAgentAuth
 */
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { cursorAgentCommand } from "./cursorRuntime.ts";
import { runCursorAgentCommand } from "./cursorAgentStatus.ts";

const LOGIN_METHOD_ID = "cursor-agent-login";
const TRANSCRIPT_LIMIT = 16_384;

export const makeCursorAgentAuth = Effect.fn("makeCursorAgentAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CursorSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  const login = (context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (Option.isNone(pty)) {
        return yield* failure(
          "start",
          "Interactive sign-in is unavailable here. Run `cursor-agent login` in a terminal.",
        );
      }
      const exited = yield* Deferred.make<number>();
      const output = yield* Queue.sliding<string>(64);
      const process = yield* pty.value
        .spawn({
          shell: cursorAgentCommand(options.settings),
          args: ["login"],
          cwd: options.cwd,
          cols: 80,
          rows: 24,
          env: options.environment,
        })
        .pipe(
          Effect.mapError((cause) =>
            failure("start", "Could not start `cursor-agent login`.", cause),
          ),
        );
      const detachData = process.onData((data) => {
        Queue.offerUnsafe(output, data.slice(-TRANSCRIPT_LIMIT));
      });
      const detachExit = process.onExit(({ exitCode }) => {
        Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          detachData();
          detachExit();
          try {
            process.kill();
          } catch {}
        }),
      );
      let transcript = "";
      let outputOffset = 0;
      const update = () =>
        context.setInteraction(
          { type: "terminal", id: "terminal", output: transcript, outputOffset },
          (response) =>
            response.type === "terminal"
              ? Effect.try({
                  try: () => {
                    if (response.size) process.resize(response.size.cols, response.size.rows);
                    if (response.data) process.write(response.data);
                  },
                  catch: () => failure("respond", "The sign-in terminal is no longer available."),
                })
              : Effect.void,
        );
      yield* update();
      yield* Queue.take(output).pipe(
        Effect.flatMap((data) => {
          outputOffset += data.length;
          transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
          return update();
        }),
        Effect.forever,
        Effect.forkScoped,
      );
      if ((yield* Deferred.await(exited)) !== 0) {
        return yield* failure("start", "`cursor-agent login` did not finish successfully.");
      }
      yield* context.verifying;
      yield* options.onChanged(true);
    });

  const logout = runCursorAgentCommand(options.settings, ["logout"], options.environment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => failure("logout", "`cursor-agent logout` failed.", cause)),
    Effect.flatMap((result) =>
      result.code === 0
        ? options.onChanged(false).pipe(Effect.as("Signed out of the Cursor CLI."))
        : Effect.fail(failure("logout", "`cursor-agent logout` did not finish successfully.")),
    ),
  );

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // The CLI keeps one login per machine user, shared by every instance.
    credentialBinding: { owner: "provider", key: "cursor-agent" },
    methods: Effect.succeed(
      Option.isSome(pty)
        ? [
            {
              id: LOGIN_METHOD_ID,
              name: "Sign in with the Cursor CLI",
              description: "Runs `cursor-agent login`.",
              type: "terminal" as const,
            },
          ]
        : [],
    ),
    defaultMethodId: LOGIN_METHOD_ID,
    authenticate: (_methodId, context) => login(context),
    logout,
  });
  return { controller, canSignIn: Option.isSome(pty) };
});
