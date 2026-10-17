import { describe, expect, it } from "vite-plus/test";
import { withAgentDeviceEnvironment } from "./mcpSession.ts";

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

it("scopes the review CLI to its provider session and preserves the device launcher", () => {
  const environment = withAgentDeviceEnvironment(
    { PATH: "/provider/bin", PROVIDER_KEY: "fixture" },
    {
      authorizationHeader: "Bearer fixture-review",
      reviewEndpoint: "unix:/tmp/viewcode-test.sock",
      reviewCliShimDir: "/viewcode/review/bin",
      agentDeviceEnvironment: {
        PATH: "/viewcode/device/bin",
        PATH_SEPARATOR: ":",
        AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      },
    },
  );
  expect(environment).toEqual({
    PATH: "/viewcode/device/bin:/viewcode/review/bin:/provider/bin",
    PROVIDER_KEY: "fixture",
    VIEWCODE_REVIEW_AUTH: "fixture-review",
    VIEWCODE_REVIEW_ENDPOINT: "unix:/tmp/viewcode-test.sock",
    AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
  });
});

it("supplies browser CLI access alongside device and review CLIs only with browser authority", () => {
  const config = {
    authorizationHeader: "Bearer fixture-session",
    browserEndpoint: "unix:/tmp/browser.sock",
    browserCliShimDir: "/viewcode/browser/bin",
    browserToolsAvailable: true,
    reviewEndpoint: "unix:/tmp/browser.sock",
    reviewCliShimDir: "/viewcode/review/bin",
    agentDeviceEnvironment: { PATH: "/viewcode/computer/bin", PATH_SEPARATOR: ":" },
  };
  const environment = withAgentDeviceEnvironment({ PATH: "/usr/bin" }, config);
  expect(environment).toMatchObject({
    VIEWCODE_BROWSER_ENDPOINT: "unix:/tmp/browser.sock",
    VIEWCODE_BROWSER_AUTH: "Bearer fixture-session",
    PATH: "/viewcode/computer/bin:/viewcode/review/bin:/viewcode/browser/bin:/usr/bin",
  });
  const denied = withAgentDeviceEnvironment(
    { PATH: "/usr/bin" },
    { ...config, browserToolsAvailable: false },
  );
  expect(denied).not.toHaveProperty("VIEWCODE_BROWSER_AUTH");
  expect(denied.PATH).not.toContain("/viewcode/browser/bin");
});

it("uses the session's Windows PATH separator even without a device grant", () => {
  const environment = withAgentDeviceEnvironment(
    { Path: "C:\\Windows" },
    {
      authorizationHeader: "Bearer fixture",
      browserEndpoint: "http://localhost/api/browser",
      browserCliShimDir: "C:\\ViewCode\\browser",
      browserToolsAvailable: true,
      cliPathSeparator: ";",
    },
  );
  expect(environment.PATH).toBe("C:\\ViewCode\\browser;C:\\Windows");
});
