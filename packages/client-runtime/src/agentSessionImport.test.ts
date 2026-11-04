import { ProviderInstanceId, type AgentSessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  importSelection,
  partitionImportableSessions,
  sessionKey,
  toggleSelectAll,
} from "./agentSessionImport.ts";

function session(
  providerSessionId: string,
  lastActivityAt: string,
  options: { hiddenReason?: AgentSessionSummary["hiddenReason"]; alreadyImported?: boolean } = {},
): AgentSessionSummary {
  const hiddenReason = options.hiddenReason ?? null;
  return {
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId,
    provider: "codex",
    title: providerSessionId,
    firstActivityAt: lastActivityAt,
    lastActivityAt,
    userMessageCount: 3,
    alreadyImported: options.alreadyImported ?? false,
    hidden: hiddenReason !== null,
    hiddenReason,
  };
}

const older = session("older", "2026-08-01T00:00:00.000Z");
const newer = session("newer", "2026-08-20T00:00:00.000Z");
const imported = session("imported", "2026-08-10T00:00:00.000Z", { alreadyImported: true });
const child = session("child", "2026-08-21T00:00:00.000Z", { hiddenReason: "subagent" });
const keys = (...sessions: ReadonlyArray<AgentSessionSummary>) =>
  new Set(sessions.map((entry) => sessionKey(entry)));

describe("partitionImportableSessions", () => {
  it("sorts newest first and folds hidden sessions away", () => {
    expect(partitionImportableSessions([older, child, newer])).toEqual({
      visible: [newer, older],
      hidden: [child],
    });
  });
});

describe("importSelection", () => {
  const shown = [newer, imported, older];

  it("is none with nothing ticked", () => {
    expect(importSelection(shown, new Set())).toEqual({ selected: [], state: "none" });
  });

  it("is some with part of the importable rows ticked", () => {
    expect(importSelection(shown, keys(older))).toEqual({ selected: [older], state: "some" });
  });

  it("is all once every importable row is ticked, leaving imported rows out", () => {
    expect(importSelection(shown, keys(newer, older))).toEqual({
      selected: [newer, older],
      state: "all",
    });
  });

  it("does not count a ticked hidden row while it is folded away", () => {
    expect(importSelection([newer, older], keys(newer, child))).toEqual({
      selected: [newer],
      state: "some",
    });
    expect(importSelection([newer, older, child], keys(newer, child)).selected).toEqual([
      newer,
      child,
    ]);
  });

  it("is none when no shown row can be imported", () => {
    expect(importSelection([imported], keys(imported)).state).toBe("none");
  });
});

describe("toggleSelectAll", () => {
  it("ticks every shown importable row from none and from some", () => {
    expect(toggleSelectAll([newer, imported, older], new Set())).toEqual(keys(newer, older));
    expect(toggleSelectAll([newer, older], keys(older))).toEqual(keys(newer, older));
  });

  it("clears the shown rows from all", () => {
    expect(toggleSelectAll([newer, older], keys(newer, older))).toEqual(new Set());
  });

  it("leaves hidden rows alone while they are folded away", () => {
    expect(toggleSelectAll([newer, older], new Set())).not.toContain(sessionKey(child));
    expect(toggleSelectAll([newer, older], keys(newer, older, child))).toEqual(keys(child));
  });

  it("includes hidden rows once they are shown", () => {
    expect(toggleSelectAll([newer, older, child], new Set())).toEqual(keys(newer, older, child));
  });
});
