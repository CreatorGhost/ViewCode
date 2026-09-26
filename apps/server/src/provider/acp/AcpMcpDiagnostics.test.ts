import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import { summarizeMcpServers, unsupportedMcpTransports } from "./AcpMcpDiagnostics.ts";

const stdio: EffectAcpSchema.McpServer = {
  name: "private-server",
  command: "/private/command",
  args: ["private-argument"],
  env: [{ name: "TOKEN", value: "private-token" }],
};
const http: EffectAcpSchema.McpServer = {
  name: "private-server",
  type: "http",
  url: "https://private-host/mcp",
  headers: [{ name: "Authorization", value: "private-token" }],
};
const sse: EffectAcpSchema.McpServer = { ...http, type: "sse" };

describe("ACP MCP diagnostics", () => {
  it("distinguishes empty attachment from configured servers without exposing credentials", () => {
    expect(summarizeMcpServers([])).toEqual({
      mcpServerCount: 0,
      mcpTransports: [],
      toolsAvailability: "not-configured",
    });
    expect(summarizeMcpServers([stdio, http, http, sse])).toEqual({
      mcpServerCount: 4,
      mcpTransports: ["stdio", "http", "sse"],
      toolsAvailability: "unverified",
    });
  });

  it("accepts mandatory stdio even when optional capabilities are absent or false", () => {
    expect(unsupportedMcpTransports([stdio], undefined)).toEqual([]);
    expect(unsupportedMcpTransports([stdio], { http: false, sse: false })).toEqual([]);
  });

  it("requires each optional transport to be explicitly advertised", () => {
    expect(unsupportedMcpTransports([stdio, http, sse], undefined)).toEqual(["http", "sse"]);
    expect(unsupportedMcpTransports([http, http, sse], { http: true })).toEqual(["sse"]);
    expect(unsupportedMcpTransports([http, sse], { http: false, sse: true })).toEqual(["http"]);
    expect(unsupportedMcpTransports([stdio, http, sse], { http: true, sse: true })).toEqual([]);
  });
});
