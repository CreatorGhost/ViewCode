import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

/**
 * How a provider launches the stdio bridge to `/mcp` when the server listens
 * on a socket instead of a TCP port. `env` carries the bearer credential.
 */
export interface McpStdioLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Set when the server has no TCP listener. Providers must then launch this
   * stdio bridge instead of dialing `endpoint`, which no one listens on.
   */
  readonly stdio?: McpStdioLaunch;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

export const MCP_SERVER_NAME = "t3-code";

type McpTransportConfig = Pick<
  McpProviderSessionConfig,
  "endpoint" | "authorizationHeader" | "stdio"
>;

/** Claude Agent SDK `mcpServers` entry. */
export function claudeMcpServerConfig(config: McpTransportConfig) {
  return config.stdio
    ? {
        type: "stdio" as const,
        command: config.stdio.command,
        args: [...config.stdio.args],
        env: { ...config.stdio.env },
      }
    : {
        type: "http" as const,
        url: config.endpoint,
        headers: { Authorization: config.authorizationHeader },
      };
}

/** ACP `session/new` `mcpServers` entry (Cursor, Grok, Antigravity). */
export function acpMcpServerConfig(config: McpTransportConfig): EffectAcpSchema.McpServer {
  return config.stdio
    ? {
        name: MCP_SERVER_NAME,
        command: config.stdio.command,
        args: [...config.stdio.args],
        env: Object.entries(config.stdio.env).map(([name, value]) => ({ name, value })),
      }
    : {
        type: "http",
        name: MCP_SERVER_NAME,
        url: config.endpoint,
        headers: [{ name: "Authorization", value: config.authorizationHeader }],
      };
}

/** OpenCode `mcp.add` config. */
export function openCodeMcpServerConfig(config: McpTransportConfig) {
  return config.stdio
    ? {
        type: "local" as const,
        command: [config.stdio.command, ...config.stdio.args],
        environment: { ...config.stdio.env },
      }
    : {
        type: "remote" as const,
        url: config.endpoint,
        headers: { Authorization: config.authorizationHeader },
        oauth: false as const,
      };
}

// TOML basic strings share JSON's escapes for everything JSON.stringify emits.
const tomlString = (value: string) => JSON.stringify(value);

/**
 * Codex app-server `-c` overrides that register the server. The URL form
 * reads the credential from `T3_MCP_BEARER_TOKEN` in the app-server's own
 * environment; the stdio form hands it to the bridge, since Codex starts stdio
 * servers with a cleared environment.
 */
export function codexMcpConfigArgs(config: McpTransportConfig): ReadonlyArray<string> {
  const key = `mcp_servers.${MCP_SERVER_NAME}`;
  if (config.stdio) {
    const env = Object.entries(config.stdio.env)
      .map(([name, value]) => `${name}=${tomlString(value)}`)
      .join(",");
    return [
      "-c",
      `${key}.command=${tomlString(config.stdio.command)}`,
      "-c",
      `${key}.args=[${config.stdio.args.map(tomlString).join(",")}]`,
      "-c",
      `${key}.env={${env}}`,
    ];
  }
  return [
    "-c",
    `${key}.url=${config.endpoint}`,
    "-c",
    `${key}.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`,
  ];
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
