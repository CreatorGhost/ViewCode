import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  partitionMcpServers,
  summarizeMcpServers,
  unsupportedMcpTransports,
  viewcodeToolsUnavailableWarning,
} from "./AcpMcpDiagnostics.ts";

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

  it("drops HTTP when mcpCapabilities is absent so the session can still start", () => {
    expect(partitionMcpServers([stdio, http], undefined)).toEqual({
      unsupportedTransports: ["http"],
      supportedServers: [stdio],
    });
    expect(partitionMcpServers([http], null).supportedServers).toEqual([]);
  });

  it("drops HTTP when the agent explicitly reports http: false", () => {
    expect(partitionMcpServers([http], { http: false })).toEqual({
      unsupportedTransports: ["http"],
      supportedServers: [],
    });
    expect(partitionMcpServers([http], { http: true })).toEqual({
      unsupportedTransports: [],
      supportedServers: [http],
    });
  });

  it("words the user-facing warning and keeps the reason in the detail", () => {
    const dropped = viewcodeToolsUnavailableWarning("Cursor", {
      kind: "unsupported-transport",
      unsupportedTransports: ["http"],
    });
    expect(dropped.message).toBe(
      "ViewCode tools aren't available in this chat (Cursor didn't accept the tool connection). Child agents and agent messaging won't work here; you can still create child agents from the sidebar.",
    );
    expect(dropped.detail).toContain("http");
    expect(viewcodeToolsUnavailableWarning("Grok", { kind: "not-issued" }).detail).toContain(
      "did not issue",
    );
  });
});
