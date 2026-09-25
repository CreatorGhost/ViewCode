import { describe, expect, it } from "vite-plus/test";
import {
  acpMcpServerConfig,
  claudeMcpServerConfig,
  codexMcpConfigArgs,
  openCodeMcpServerConfig,
  withAgentDeviceEnvironment,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("provider MCP transport config", () => {
  const http = {
    endpoint: "http://127.0.0.1:3773/mcp",
    authorizationHeader: "Bearer secret",
  };
  const socket = {
    endpoint: "http://localhost/mcp",
    authorizationHeader: "Bearer secret",
    stdio: {
      command: "/opt/T3 Code/t3",
      args: ["/opt/T3 Code/mcp-stdio-bridge.mjs", "--socket", '/tmp/t3code-1000/a "b".sock'],
      env: { ELECTRON_RUN_AS_NODE: "1", T3_MCP_BEARER_TOKEN: "secret" },
    },
  };

  it("dials the URL when the server has a TCP port", () => {
    expect(claudeMcpServerConfig(http)).toEqual({
      type: "http",
      url: http.endpoint,
      headers: { Authorization: "Bearer secret" },
    });
    expect(acpMcpServerConfig(http)).toEqual({
      type: "http",
      name: "t3-code",
      url: http.endpoint,
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
    expect(openCodeMcpServerConfig(http)).toMatchObject({ type: "remote", url: http.endpoint });
    expect(codexMcpConfigArgs(http)).toEqual([
      "-c",
      "mcp_servers.t3-code.url=http://127.0.0.1:3773/mcp",
      "-c",
      'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
    ]);
  });

  it("launches the stdio bridge when the server listens on a socket", () => {
    expect(claudeMcpServerConfig(socket)).toEqual({ type: "stdio", ...socket.stdio });
    expect(acpMcpServerConfig(socket)).toEqual({
      name: "t3-code",
      command: socket.stdio.command,
      args: socket.stdio.args,
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "T3_MCP_BEARER_TOKEN", value: "secret" },
      ],
    });
    expect(openCodeMcpServerConfig(socket)).toEqual({
      type: "local",
      command: [socket.stdio.command, ...socket.stdio.args],
      environment: socket.stdio.env,
    });
  });

  it("writes Codex stdio overrides as TOML values", () => {
    const [, command, , args, , env] = codexMcpConfigArgs(socket);
    expect(command).toBe('mcp_servers.t3-code.command="/opt/T3 Code/t3"');
    expect(args).toBe(
      'mcp_servers.t3-code.args=["/opt/T3 Code/mcp-stdio-bridge.mjs","--socket","/tmp/t3code-1000/a \\"b\\".sock"]',
    );
    expect(env).toBe(
      'mcp_servers.t3-code.env={ELECTRON_RUN_AS_NODE="1",T3_MCP_BEARER_TOKEN="secret"}',
    );
  });
});
