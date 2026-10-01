import { describe, expect, it } from "vite-plus/test";

import { deriveViewcodeToolsNotice } from "./viewcodeTools.ts";

const toolsWarning = (reason: "managed-mcp" | "setting") => ({
  kind: "runtime.warning",
  payload: {
    message: `ViewCode tools are off (${reason}).`,
    detail: { viewcodeTools: "unavailable", reason },
  },
});

describe("deriveViewcodeToolsNotice", () => {
  it("shows the server's notice with an explanation for a managed machine", () => {
    const notice = deriveViewcodeToolsNotice({
      threadId: "thread-1",
      activities: [toolsWarning("managed-mcp")],
      sessionProviderName: "claudeAgent",
    });
    expect(notice?.reason).toBe("managed-mcp");
    expect(notice?.text).toBe("ViewCode tools are off (managed-mcp).");
    expect(notice?.why).toContain("ask your IT team to add ViewCode's MCP server");
    expect(notice?.key).toBe("viewcode-tools:thread-1:managed-mcp");
  });

  it("explains the setting when the user turned the tools off", () => {
    const notice = deriveViewcodeToolsNotice({
      threadId: "thread-1",
      activities: [toolsWarning("managed-mcp"), toolsWarning("setting")],
      sessionProviderName: null,
    });
    expect(notice?.reason).toBe("setting");
    expect(notice?.why).toContain("Settings → Providers → Claude");
  });

  it("stays hidden for ordinary warnings and once the thread moved off Claude", () => {
    expect(
      deriveViewcodeToolsNotice({
        threadId: "thread-1",
        activities: [{ kind: "runtime.warning", payload: { message: "Rate limited" } }],
        sessionProviderName: "claudeAgent",
      }),
    ).toBeNull();
    expect(
      deriveViewcodeToolsNotice({
        threadId: "thread-1",
        activities: [toolsWarning("managed-mcp")],
        sessionProviderName: "codex",
      }),
    ).toBeNull();
  });
});
