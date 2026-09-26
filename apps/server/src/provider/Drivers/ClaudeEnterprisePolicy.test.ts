// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import {
  buildClaudeCapabilitiesProbeQueryOptions,
  checkClaudeProviderStatus,
} from "../Layers/ClaudeProvider.ts";
import {
  ClaudeManagedMcpConfigPaths,
  hasClaudeManagedMcpConfig,
} from "./ClaudeEnterprisePolicy.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encoder = new TextEncoder();

const policyFile = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-policy-"));
  const file = NodePath.join(dir, "managed-mcp.json");
  NodeFS.writeFileSync(file, "{}");
  return file;
};
const missingPolicy = NodePath.join(NodeOS.tmpdir(), "t3-no-such-dir", "managed-mcp.json");

function recordingSpawner(
  respond: (args: ReadonlyArray<string>) => { stdout: string; code: number },
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = command._tag === "StandardCommand" ? command.args : [];
      calls.push(args);
      const { stdout, code } = respond(args);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, calls };
}

describe("Claude enterprise MCP policy", () => {
  it.effect("detects the managed MCP file at the given locations", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* hasClaudeManagedMcpConfig.pipe(
          Effect.provideService(ClaudeManagedMcpConfigPaths, [missingPolicy, policyFile()]),
        ),
      );
      assert.isFalse(
        yield* hasClaudeManagedMcpConfig.pipe(
          Effect.provideService(ClaudeManagedMcpConfigPaths, [missingPolicy]),
        ),
      );
    }),
  );

  it("drops the strict MCP flag from the probe only under a policy", () => {
    const base = {
      executablePath: "/usr/local/bin/claude",
      abortController: new AbortController(),
      environment: {},
      cwd: undefined,
    };
    const strict = buildClaudeCapabilitiesProbeQueryOptions(base);
    const managed = buildClaudeCapabilitiesProbeQueryOptions({ ...base, managedMcpConfig: true });
    assert.strictEqual(strict.strictMcpConfig, true);
    assert.isUndefined(managed.strictMcpConfig);
    // Still no configured MCP servers and no claude.ai connectors.
    assert.deepStrictEqual(managed.mcpServers, {});
    assert.strictEqual(managed.env?.["ENABLE_CLAUDEAI_MCP_SERVERS"], "false");
  });

  it.effect("drops --strict-mcp-config from text generation only under a policy", () =>
    Effect.gen(function* () {
      for (const [paths, expectStrict] of [
        [[policyFile()], false],
        [[missingPolicy], true],
      ] as const) {
        const { spawner, calls } = recordingSpawner(() => ({ stdout: "", code: 1 }));
        const textGeneration = yield* makeClaudeTextGeneration(decodeClaudeSettings({})).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "branch",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-5",
            },
          })
          .pipe(Effect.provideService(ClaudeManagedMcpConfigPaths, paths), Effect.ignore);
        assert.isAtLeast(calls.length, 1);
        assert.strictEqual(calls[0]?.includes("--strict-mcp-config"), expectStrict);
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-policy-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("Claude status when the SDK probe fails", () => {
  it.effect("shows the account from `claude auth status` and the probe's error", () =>
    Effect.gen(function* () {
      const { spawner } = recordingSpawner((args) =>
        args.join(" ") === "auth status"
          ? {
              stdout:
                '{"loggedIn":true,"authMethod":"claude.ai","email":"dev@example.com","subscriptionType":"max"}',
              code: 0,
            }
          : { stdout: "2.1.0\n", code: 0 },
      );
      const status = yield* checkClaudeProviderStatus(decodeClaudeSettings({}), () =>
        Effect.succeed({
          email: undefined,
          subscriptionType: undefined,
          tokenSource: undefined,
          apiProvider: undefined,
          slashCommands: [],
          probeError: "--strict-mcp-config is not allowed with an enterprise MCP config",
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.status, "authenticated");
      assert.strictEqual(status.auth.email, "dev@example.com");
      assert.include(status.message, "enterprise MCP config");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the warning, with the probe's error, when auth status can't confirm", () =>
    Effect.gen(function* () {
      const { spawner } = recordingSpawner((args) =>
        args.join(" ") === "auth status"
          ? { stdout: '{"loggedIn":false}', code: 1 }
          : { stdout: "2.1.0\n", code: 0 },
      );
      const status = yield* checkClaudeProviderStatus(decodeClaudeSettings({}), () =>
        Effect.succeed({
          email: undefined,
          subscriptionType: undefined,
          tokenSource: undefined,
          apiProvider: undefined,
          slashCommands: [],
          probeError: "Timed out waiting for Claude to initialize.",
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.strictEqual(status.status, "warning");
      assert.include(status.message, "Timed out waiting for Claude to initialize.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
