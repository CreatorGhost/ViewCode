import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidechatModelSelection, resolveSidechatWhileCreating } from "./sidechatModel";

describe("resolveSidechatWhileCreating", () => {
  const older = { id: ThreadId.make("older") };
  const created = { id: ThreadId.make("created") };

  it("keeps the normal latest-chat fallback outside creation", () => {
    expect(resolveSidechatWhileCreating(older, null)).toBe(older);
    expect(resolveSidechatWhileCreating(null, null)).toBeNull();
  });

  it("waits for the newly created shell rather than displaying or replying to an older chat", () => {
    expect(resolveSidechatWhileCreating(older, created.id)).toBeNull();
    expect(resolveSidechatWhileCreating(null, created.id)).toBeNull();
  });

  it("opens the created chat as soon as its shell arrives", () => {
    expect(resolveSidechatWhileCreating(created, created.id)).toBe(created);
  });
});

const parentSelection = {
  instanceId: ProviderInstanceId.make("codex-primary"),
  model: "gpt-5.4",
};
const sidechatSelection = {
  instanceId: ProviderInstanceId.make("claude-work"),
  model: "sonnet",
};
const picked = {
  instanceId: ProviderInstanceId.make("claude-personal"),
  model: "opus",
  options: [{ id: "effort", value: "high" }],
};

describe("resolveSidechatModelSelection", () => {
  it("inherits the existing side chat's model when continuing a laptop conversation", () => {
    expect(
      resolveSidechatModelSelection({ picked: null, sidechatSelection, parentSelection }),
    ).toBe(sidechatSelection);
  });

  it("inherits the parent for a fresh side chat", () => {
    expect(
      resolveSidechatModelSelection({ picked: null, sidechatSelection: null, parentSelection }),
    ).toBe(parentSelection);
  });

  it("preserves the chosen provider instance and options for both creation and follow-ups", () => {
    for (const existing of [null, sidechatSelection]) {
      expect(
        resolveSidechatModelSelection({ picked, sidechatSelection: existing, parentSelection }),
      ).toBe(picked);
    }
  });

  it("returns to the inherited selection when a local pick is cleared", () => {
    expect(
      resolveSidechatModelSelection({ picked: null, sidechatSelection, parentSelection }),
    ).toBe(sidechatSelection);
    expect(
      resolveSidechatModelSelection({
        picked: null,
        sidechatSelection: null,
        parentSelection: null,
      }),
    ).toBeNull();
  });
});
