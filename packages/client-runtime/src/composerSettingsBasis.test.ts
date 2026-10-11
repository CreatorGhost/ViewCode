import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  markComposerPicks,
  reconcileComposerPicks,
  type ComposerThreadSettings,
} from "./composerSettingsBasis.ts";

const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const gpt: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" };

const server = (modelSelection: ModelSelection): ComposerThreadSettings => ({
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
});

describe("reconcileComposerPicks", () => {
  it("binds a fresh pick to the server value the composer sees", () => {
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection"],
        basis: markComposerPicks(undefined, ["modelSelection"]),
        server: server(opus),
      }),
    ).toEqual({ drop: [], basis: { modelSelection: opus } });
  });

  it("keeps a pick while the server still holds the value it was made against", () => {
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection"],
        basis: { modelSelection: { ...opus, options: [{ id: "effort", value: "high" }] } },
        server: server(opus),
      }),
    ).toBeNull();
  });

  it("drops a pick once the server value changed elsewhere", () => {
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection"],
        basis: { modelSelection: opus },
        server: server(gpt),
      }),
    ).toEqual({ drop: ["modelSelection"], basis: undefined });
  });

  it("keeps a pick made after the server changed", () => {
    // The pick was bound to the new server value, so it is the newer intent.
    const bound = reconcileComposerPicks({
      picked: ["modelSelection"],
      basis: markComposerPicks({ modelSelection: opus }, ["modelSelection"]),
      server: server(gpt),
    });
    expect(bound).toEqual({ drop: [], basis: { modelSelection: gpt } });
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection"],
        basis: bound?.basis,
        server: server(gpt),
      }),
    ).toBeNull();
  });

  it("makes picks from drafts without a basis follow the server", () => {
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection", "runtimeMode"],
        basis: undefined,
        server: server(opus),
      }),
    ).toEqual({ drop: ["modelSelection", "runtimeMode"], basis: undefined });
  });

  it("decides each setting on its own", () => {
    expect(
      reconcileComposerPicks({
        picked: ["modelSelection", "interactionMode"],
        basis: { modelSelection: opus, interactionMode: "default" },
        server: { ...server(gpt), interactionMode: "default" },
      }),
    ).toEqual({ drop: ["modelSelection"], basis: { interactionMode: "default" } });
  });

  it("forgets a basis whose pick is gone", () => {
    expect(
      reconcileComposerPicks({
        picked: [],
        basis: { runtimeMode: "full-access" },
        server: server(opus),
      }),
    ).toEqual({ drop: [], basis: undefined });
  });

  it("does nothing without picks", () => {
    expect(
      reconcileComposerPicks({ picked: [], basis: undefined, server: server(opus) }),
    ).toBeNull();
  });
});
