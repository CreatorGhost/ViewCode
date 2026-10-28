/**
 * ViewCode guard: a floating preview opens at a size that grows with the chat area, so the
 * agent's browser is readable on a large window instead of a fixed 320px thumbnail. It stays
 * within 320 to 640px wide and keeps the source's aspect ratio.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

const browser = { width: 1_600, height: 1_000 };
const open = (container: { width: number; height: number }) =>
  resolvePreviewMiniPlayerFrame({ width: null, position: null, source: browser, container });

describe("floating preview default size (ViewCode)", () => {
  it("opens large on a large chat area, capped at 640px wide", () => {
    expect(open({ width: 1_700, height: 1_000 })).toEqual({
      x: 1_700 - PREVIEW_MINI_PLAYER_EDGE_GAP - 640,
      y: PREVIEW_MINI_PLAYER_EDGE_GAP,
      width: 640,
      height: 400,
    });
    expect(open({ width: 3_000, height: 2_000 }).width).toBe(640);
  });

  it("never opens smaller than the old 320px default", () => {
    expect(open({ width: 700, height: 500 })).toMatchObject({ width: 320, height: 200 });
  });

  it("keeps a size the user chose", () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 300,
        position: { x: 40, y: 40 },
        source: browser,
        container: { width: 1_700, height: 1_000 },
      }),
    ).toMatchObject({ width: 300, height: 188 });
  });
});
