import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundWorkspaceSnapshotsForWire } from "./providerWire.ts";

const checkedAt = "2026-10-21T00:00:00.000Z";

function provider(name: string, folders: number, descriptionBytes: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(name),
    driver: ProviderDriverKind.make(name),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: Array.from({ length: folders }, (_, index) => ({
      cwd: `/work/${name}-${index}`,
      checkedAt,
      slashCommands: [{ name: `command-${index}` }],
      skills: [
        {
          name: `skill-${index}`,
          path: `/work/${name}-${index}/SKILL.md`,
          description: "x".repeat(descriptionBytes),
          enabled: true,
        },
      ],
    })),
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("boundWorkspaceSnapshotsForWire", () => {
  it("keeps a config message under the relay limit, newest catalogs first", () => {
    // Sixteen folders with large skill catalogs, as in the original regression.
    const providers = [provider("claude", 16, 80_000), provider("codex", 16, 20_000)];
    expect(bytes(providers)).toBeGreaterThan(1024 * 1024);

    const bounded = boundWorkspaceSnapshotsForWire(providers);

    expect(bytes(bounded)).toBeLessThan(512 * 1024);
    expect(bounded[0]?.workspaceSnapshots?.at(-1)?.cwd).toBe("/work/claude-15");
    expect(bounded[1]?.workspaceSnapshots?.at(-1)?.cwd).toBe("/work/codex-15");
    expect(bounded[1]?.workspaceSnapshots?.length).toBeGreaterThan(1);
  });

  it("leaves small catalogs alone and always keeps the newest one", () => {
    const small = [provider("codex", 4, 100)];
    expect(boundWorkspaceSnapshotsForWire(small)).toBe(small);

    const huge = boundWorkspaceSnapshotsForWire([provider("claude", 3, 400_000)]);
    expect(huge[0]?.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([
      "/work/claude-2",
    ]);
  });
});
