import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { codexThreadRuntimeParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { cursorMcpServers } from "@t3tools/provider-cursor/testing";

it("configures native providers with the stdio socket bridge and keeps the token out of arguments", () => {
  const stdio = {
    command: "/node",
    args: ["/bridge.mjs", "--socket", "/private/backend.sock"],
    env: { T3_MCP_BEARER_TOKEN: "test-only-token" },
  };
  const session = {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "unix:/private/backend.sock",
    authorizationHeader: "Bearer test-only-token",
    browserToolsAvailable: true,
    stdio,
  };
  const codex = codexThreadRuntimeParams({ mcpSession: session }).config;
  assert.deepEqual(codex.mcp_servers, { "t3-code": { ...stdio, tool_timeout_sec: 65 * 60 } });
  const claude = claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false });
  assert.deepEqual(claude.mcpServers?.["t3-code"], { ...stdio, timeout: 65 * 60 * 1000 });
  assert.deepEqual(cursorMcpServers(session), { "t3-code": { type: "stdio", ...stdio } });
  assert.notInclude(JSON.stringify(stdio.args), "test-only-token");
});
