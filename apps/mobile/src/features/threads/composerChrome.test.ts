import { describe, expect, it } from "vite-plus/test";

import {
  liveRingWedges,
  resolveComposerCheckout,
  resolveComposerGlowPaint,
} from "./composerChrome";

const alphaOf = (color: string) => Number(/,\s*([\d.]+)\)$/.exec(color)?.[1]);

describe("resolveComposerGlowPaint", () => {
  it("follows the project's colour, in the shade web uses for the appearance", () => {
    const dark = resolveComposerGlowPaint({
      projectColor: "teal",
      appearance: "dark",
      accentColor: "#346bf1",
      surfaceColor: "#0a0a0a",
    });
    expect(dark.color).toBe("rgba(0, 213, 190, 1)");
    expect(dark.border).toBe("rgba(0, 213, 190, 0.45)");

    const light = resolveComposerGlowPaint({
      projectColor: "teal",
      appearance: "light",
      accentColor: "#1b4ed8",
      surfaceColor: "#fcfcfc",
    });
    expect(light.color).toBe("rgba(0, 187, 167, 1)");
    // A light surface halves the glow, as on web.
    expect(light.border).toBe("rgba(0, 187, 167, 0.35)");
  });

  it("uses the theme accent when the project has no colour", () => {
    const paint = resolveComposerGlowPaint({
      projectColor: null,
      appearance: "dark",
      accentColor: "rgba(52, 107, 241, 0.9)",
      surfaceColor: "#0a0a0a",
    });
    expect(paint.color).toBe("rgba(52, 107, 241, 1)");
  });

  it("fades the halo outward from the edge", () => {
    const { halo } = resolveComposerGlowPaint({
      projectColor: "rose",
      appearance: "dark",
      accentColor: "#346bf1",
      surfaceColor: "#0a0a0a",
    });
    const alphas = halo.map((band) => alphaOf(band.color));
    expect(alphas[0]).toBeLessThan(0.28);
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeLessThan(alphas[index - 1]!);
    }
    expect(halo.map((band) => band.offset)).toEqual([3, 6, 9, 12, 15, 18]);
  });
});

describe("liveRingWedges", () => {
  it("covers the full turn without gaps, brightest near web's 336deg head", () => {
    const wedges = liveRingWedges("#00d5be");
    expect(wedges[0]!.from).toBe(0);
    expect(wedges.at(-1)!.to).toBe(360);
    for (let index = 1; index < wedges.length; index += 1) {
      expect(wedges[index]!.from).toBe(wedges[index - 1]!.to);
    }
    const head = wedges.find((wedge) => wedge.from <= 336 && wedge.to > 336)!;
    expect(alphaOf(head.color)).toBeGreaterThan(0.95);
    expect(alphaOf(wedges[0]!.color)).toBeLessThan(0.05);
  });
});

describe("resolveComposerCheckout", () => {
  it("names a worktree and prefers the live branch over the thread's stored one", () => {
    expect(
      resolveComposerCheckout({
        worktreePath: "/repo/.worktrees/feature",
        threadBranch: "old-name",
        gitStatus: { isRepo: true, refName: "feature/glow" },
      }),
    ).toEqual({ place: "Worktree", branch: "feature/glow" });
  });

  it("falls back to the thread's branch until git status arrives", () => {
    expect(
      resolveComposerCheckout({ worktreePath: null, threadBranch: "main", gitStatus: null }),
    ).toEqual({ place: "Local checkout", branch: "main" });
  });

  it("shows no branch outside a git repository", () => {
    expect(
      resolveComposerCheckout({
        worktreePath: null,
        threadBranch: "main",
        gitStatus: { isRepo: false, refName: null },
      }),
    ).toEqual({ place: "Local checkout", branch: null });
  });
});
