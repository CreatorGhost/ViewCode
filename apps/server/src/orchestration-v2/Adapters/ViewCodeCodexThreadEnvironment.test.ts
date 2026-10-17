import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  codexThreadEnvironment,
  codexThreadEnvironmentOverrides,
  makeCodexThreadEnvironmentTracker,
  withoutCodexThreadEnvironment,
} from "./ViewCodeCodexThreadEnvironment.ts";

const session = (id: string): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(id),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: id,
  endpoint: "http://localhost/mcp",
  authorizationHeader: `Bearer ${id}-token`,
  browserToolsAvailable: true,
  browserEndpoint: "http://localhost/browser",
  browserCliShimDir: "/tools/browser",
  reviewEndpoint: "http://localhost/review",
  reviewCliShimDir: "/tools/review",
  agentDeviceEnvironment: {
    VIEWCODE_COMPUTER_ENDPOINT: "http://localhost/computer",
    VIEWCODE_COMPUTER_AUTH: `Bearer ${id}-token`,
    VIEWCODE_COMPUTER_CLI: "/tools/computer/viewcode-computer",
    VIEWCODE_COMPUTER_SCREENSHOTS_DIR: `/captures/${id}`,
    PATH: "/tools/computer",
    PATH_SEPARATOR: ":",
  },
});

describe("Codex thread shell environment", () => {
  it("keeps each thread's CLI credentials out of the reusable app-server process", () => {
    const processEnvironment = {
      PATH: "/usr/bin",
      COMPANY_SETTING: "retained",
      VIEWCODE_COMPUTER_AUTH: "old",
      VIEWCODE_BROWSER_AUTH: "old",
      VIEWCODE_REVIEW_AUTH: "old",
    };
    expect(withoutCodexThreadEnvironment(processEnvironment)).toEqual({
      PATH: "/usr/bin",
      COMPANY_SETTING: "retained",
    });
    const first = codexThreadEnvironmentOverrides({
      environment: codexThreadEnvironment(session("first")),
      processEnvironment,
      shellConfig: undefined,
    });
    const second = codexThreadEnvironmentOverrides({
      environment: codexThreadEnvironment(session("second")),
      processEnvironment,
      shellConfig: undefined,
    });
    for (const [overrides, id] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      expect(overrides["shell_environment_policy.set.VIEWCODE_COMPUTER_AUTH"]).toBe(
        `Bearer ${id}-token`,
      );
      expect(overrides["shell_environment_policy.set.VIEWCODE_BROWSER_AUTH"]).toBe(
        `Bearer ${id}-token`,
      );
      expect(overrides["shell_environment_policy.set.VIEWCODE_REVIEW_AUTH"]).toBe(`${id}-token`);
      expect(overrides["shell_environment_policy.set.VIEWCODE_COMPUTER_CLI"]).toBe(
        "/tools/computer/viewcode-computer",
      );
      expect(overrides["shell_environment_policy.set.PATH"]).toBe(
        "/tools/computer:/tools/review:/tools/browser:/usr/bin",
      );
    }
  });

  it("retains the enterprise PATH and never overrides shell filtering or unrelated set keys", () => {
    const shellConfig = {
      inherit: "none",
      exclude: ["CLOUD_*"],
      include_only: ["PATH", "COMPANY_*"],
      set: { PATH: "/company/tools", COMPANY_TOKEN: "enterprise-owned" },
    };
    const overrides = codexThreadEnvironmentOverrides({
      environment: codexThreadEnvironment(session("thread")),
      processEnvironment: { PATH: "/usr/bin" },
      shellConfig,
    });
    expect(overrides["shell_environment_policy.set.PATH"]).toBe(
      "/tools/computer:/tools/review:/tools/browser:/company/tools",
    );
    expect(
      Object.keys(overrides).every((key) => key.startsWith("shell_environment_policy.set.")),
    ).toBe(true);
    expect(overrides).not.toHaveProperty("shell_environment_policy.set.COMPANY_TOKEN");
    expect(shellConfig.set.COMPANY_TOKEN).toBe("enterprise-owned");
  });

  it("clears inherited or previously persisted computer credentials when that thread has no capability", () => {
    const { agentDeviceEnvironment: _computer, ...withoutComputer } = session("off");
    const overrides = codexThreadEnvironmentOverrides({
      environment: codexThreadEnvironment(withoutComputer),
      processEnvironment: { PATH: "/usr/bin" },
      shellConfig: undefined,
    });
    expect(overrides["shell_environment_policy.set.VIEWCODE_COMPUTER_AUTH"]).toBe("");
    expect(overrides["shell_environment_policy.set.VIEWCODE_COMPUTER_CLI"]).toBe("");
    expect(overrides["shell_environment_policy.set.VIEWCODE_REVIEW_AUTH"]).toBe("off-token");
    expect(overrides["shell_environment_policy.set.PATH"]).toBe(
      "/tools/review:/tools/browser:/usr/bin",
    );
  });

  it("keeps Windows PATH entries separated and does not export internal separator metadata", () => {
    const overrides = codexThreadEnvironmentOverrides({
      environment: codexThreadEnvironment({
        ...session("windows"),
        cliPathSeparator: ";",
        browserCliShimDir: "C:\\browser",
        reviewCliShimDir: "C:\\review",
        agentDeviceEnvironment: { PATH: "C:\\computer", PATH_SEPARATOR: ";" },
      }),
      processEnvironment: { Path: "C:\\Windows" },
      shellConfig: undefined,
    });
    expect(overrides["shell_environment_policy.set.PATH"]).toBe(
      "C:\\computer;C:\\review;C:\\browser;C:\\Windows",
    );
    expect(overrides).not.toHaveProperty("shell_environment_policy.set.PATH_SEPARATOR");
  });
});

it.effect("refreshes a changed credential only after the matching native close receipt", () =>
  Effect.gen(function* () {
    const tracker = yield* makeCodexThreadEnvironmentTracker;
    yield* tracker.remember("target", "off-credential");
    yield* tracker.remember("other", "other-credential");
    const unsubscribed = yield* Deferred.make<void>();
    let returned = false;
    const refresh = yield* tracker
      .refreshIfChanged({
        nativeThreadId: "target",
        credentialId: "observe-credential",
        hasPendingWork: Effect.succeed(false),
        unsubscribe: Deferred.succeed(unsubscribed, undefined).pipe(
          Effect.as("unsubscribed" as const),
        ),
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            returned = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
    yield* Deferred.await(unsubscribed);
    expect(returned).toBe(false);
    yield* tracker.closed("other");
    expect(returned).toBe(false);
    yield* tracker.closed("target");
    yield* Fiber.join(refresh);
    expect(returned).toBe(true);
    yield* tracker.remember("target", "observe-credential");
    yield* tracker.refreshIfChanged({
      nativeThreadId: "target",
      credentialId: "observe-credential",
      hasPendingWork: Effect.die("unchanged credentials must not inspect active work"),
      unsubscribe: Effect.die("unchanged credentials must not unload"),
    });
  }),
);

it.effect("refuses to unload a thread with active work or another connection's subscription", () =>
  Effect.gen(function* () {
    const tracker = yield* makeCodexThreadEnvironmentTracker;
    yield* tracker.remember("target", "old");
    const busy = yield* tracker
      .refreshIfChanged({
        nativeThreadId: "target",
        credentialId: "new",
        hasPendingWork: Effect.succeed(true),
        unsubscribe: Effect.die("must not unload active work"),
      })
      .pipe(Effect.flip);
    expect(busy.detail).toContain("background work");
    const otherConnection = yield* tracker
      .refreshIfChanged({
        nativeThreadId: "target",
        credentialId: "new",
        hasPendingWork: Effect.succeed(false),
        unsubscribe: Effect.succeed("notSubscribed" as const),
      })
      .pipe(Effect.flip);
    expect(otherConnection.detail).toContain("other Codex connection");
    yield* tracker.refreshIfChanged({
      nativeThreadId: "target",
      credentialId: "new",
      hasPendingWork: Effect.succeed(false),
      unsubscribe: Effect.succeed("notLoaded" as const),
    });
  }),
);
