import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

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
  readonly stdio?: McpStdioLaunch;
  readonly browserEndpoint?: string;
  readonly browserCliShimDir?: string;
  readonly cliPathSeparator?: string;
  readonly reviewEndpoint?: string;
  readonly computerUseEndpoint?: string;
  readonly reviewCliShimDir?: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Whether `withAgentDeviceEnvironment` puts the `viewcode-browser` CLI on this session's PATH. */
export function browserCliAvailable(config: McpProviderSessionConfig | undefined): boolean {
  return (
    config?.browserToolsAvailable === true &&
    config.browserEndpoint !== undefined &&
    config.browserCliShimDir !== undefined
  );
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | (Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> &
        Partial<
          Pick<
            McpProviderSessionConfig,
            | "reviewEndpoint"
            | "reviewCliShimDir"
            | "authorizationHeader"
            | "browserEndpoint"
            | "browserCliShimDir"
            | "browserToolsAvailable"
            | "cliPathSeparator"
          >
        >)
    | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment ?? {};
  const review =
    config?.reviewEndpoint === undefined || config.authorizationHeader === undefined
      ? {}
      : {
          VIEWCODE_REVIEW_ENDPOINT: config.reviewEndpoint,
          VIEWCODE_REVIEW_AUTH: config.authorizationHeader.replace(/^Bearer /, ""),
        };
  const browser =
    config?.browserToolsAvailable === true &&
    config.browserEndpoint !== undefined &&
    config.authorizationHeader !== undefined
      ? {
          VIEWCODE_BROWSER_ENDPOINT: config.browserEndpoint,
          VIEWCODE_BROWSER_AUTH: config.authorizationHeader,
        }
      : {};
  if (
    Object.keys(extra).length === 0 &&
    Object.keys(review).length === 0 &&
    Object.keys(browser).length === 0
  )
    return base;
  const separator = extra.PATH_SEPARATOR ?? config?.cliPathSeparator ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: deviceShimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  const shimDir = [
    deviceShimDir,
    config?.reviewCliShimDir,
    ...(config?.browserToolsAvailable === true ? [config.browserCliShimDir] : []),
  ]
    .filter(Boolean)
    .join(separator);
  return {
    ...base,
    ...rest,
    ...review,
    ...browser,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
