import { describe, expect, it } from "vite-plus/test";

import { runtimeRequestNeed, threadNeedWithAgents, threadOwnNeed } from "./threadNeedsYou.ts";

describe("runtimeRequestNeed", () => {
  it("asks the user only for approvals and questions", () => {
    expect(runtimeRequestNeed("user_input")).toBe("question");
    expect(runtimeRequestNeed("command")).toBe("approval");
    expect(runtimeRequestNeed("file-change")).toBe("approval");
    expect(runtimeRequestNeed("dynamic_tool_call")).toBeNull();
    expect(runtimeRequestNeed("auth_refresh")).toBeNull();
    expect(runtimeRequestNeed(null)).toBeNull();
  });
});

describe("thread needs", () => {
  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };

  it("counts a blocked child agent on the lead row but not as the lead's own wait", () => {
    const lead = { ...idle, pendingSubagentRequest: "user_input" as const };
    expect(threadNeedWithAgents(lead)).toBe("question");
    expect(threadOwnNeed(lead)).toBeNull();
  });

  it("ranks an approval anywhere above a question", () => {
    expect(
      threadNeedWithAgents({
        ...idle,
        hasPendingUserInput: true,
        pendingSubagentRequest: "approval",
      }),
    ).toBe("approval");
    expect(threadOwnNeed({ hasPendingApprovals: true, hasPendingUserInput: true })).toBe(
      "approval",
    );
  });

  it("does not treat an idle thread as needing the user", () => {
    expect(threadNeedWithAgents(idle)).toBeNull();
  });
});
