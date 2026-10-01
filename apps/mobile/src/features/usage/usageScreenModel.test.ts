// @effect-diagnostics globalDate:off
import type { AgentControlState, ServerProvider } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  limitDriverLabel,
  limitWarnings,
  providersAwaitingData,
  usageResumeRows,
} from "./usageScreenModel";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "commandCode",
    driver: "commandCode",
    enabled: true,
    installed: true,
    displayName: undefined,
    usageLimits: { checkedAt: "2026-01-01T00:00:00.000Z", windows: [] },
    ...overrides,
  }) as unknown as ServerProvider;

const presentations = (
  entries: ReadonlyArray<[string, string, ReadonlyArray<ServerProvider>]>,
): LimitPresentations =>
  new Map(
    entries.map(([id, label, providers]) => [
      id as never,
      { entry: { target: { label } }, serverConfig: { providers } },
    ]),
  );

describe("limitDriverLabel", () => {
  it("names every provider the server reports", () => {
    expect(limitDriverLabel("commandCode" as never)).toBe("Command Code");
    expect(limitDriverLabel("cursor" as never)).toBe("Cursor");
    expect(limitDriverLabel("claudeAgent" as never)).toBe("Claude");
    expect(limitDriverLabel("someNewDriver" as never)).toBe("someNewDriver");
  });
});

describe("providersAwaitingData", () => {
  it("lists providers with no reading yet, naming the computer only when there are several", () => {
    const one = presentations([
      [
        "env-1",
        "Laptop",
        [
          provider({}),
          provider({
            instanceId: "codex" as never,
            driver: "codex" as never,
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              windows: [{ id: "primary", kind: "session", label: "5h", usedPercent: 10 }],
            },
          }),
          provider({ instanceId: "off" as never, enabled: false }),
          provider({
            instanceId: "apikey" as never,
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              windows: [],
              unavailable: { reason: "unsupported" },
            },
          }),
        ],
      ],
    ]);
    expect(providersAwaitingData(one).map((row) => row.label)).toEqual(["Command Code"]);

    const two = presentations([
      ["env-1", "Laptop", [provider({})]],
      ["env-2", "Desktop", [provider({ displayName: "Work CC" })]],
    ]);
    expect(providersAwaitingData(two).map((row) => row.label)).toEqual([
      "Command Code · Laptop",
      "Work CC · Desktop",
    ]);
  });

  it("keeps real warnings but not the no-data line", () => {
    expect(
      limitWarnings([
        "Command Code: No usage recorded yet.",
        "Laptop · Claude: Could not read limits.",
      ]),
    ).toEqual(["Laptop · Claude: Could not read limits."]);
  });
});

describe("usageResumeRows", () => {
  const now = new Date(2026, 0, 1, 20, 0).getTime();
  const at = (hours: number, minutes: number) => new Date(2026, 0, 1, hours, minutes).toISOString();
  const state = (threadId: string, resumeAt?: string): AgentControlState =>
    ({
      threadId,
      paused: false,
      queued: 0,
      usageResume: resumeAt === undefined ? {} : { resumeAt },
    }) as AgentControlState;

  it("lists scheduled resumes soonest first, then threads waiting for the user", () => {
    const rows = usageResumeRows({
      control: new Map([
        ["env-1:waiting", state("waiting")],
        ["env-1:later", state("later", at(22, 5))],
        ["env-1:paused", { threadId: "paused", paused: true, queued: 2 } as AgentControlState],
        ["env-2:soon", state("soon", at(21, 31))],
      ]),
      titleOf: (environmentId, threadId) =>
        threadId === "later" ? null : `${environmentId}/${threadId}`,
      nowMs: now,
      locale: "en-US",
    });
    expect(rows.map((row) => [row.environmentId, row.threadId, row.title, row.text])).toEqual([
      ["env-2", "soon", "env-2/soon", "Resumes at 9:31 PM"],
      ["env-1", "later", "Untitled thread", "Resumes at 10:05 PM"],
      ["env-1", "waiting", "env-1/waiting", "Out of usage · send a message to continue"],
    ]);
  });
});
