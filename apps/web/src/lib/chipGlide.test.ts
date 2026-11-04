import { describe, expect, it } from "vite-plus/test";

import { planChipGlide } from "./chipGlide";

const plain = { hasSurface: false, reducedMotion: false };
const surface = { hasSurface: true, reducedMotion: false };

describe("planChipGlide", () => {
  it("slides a chip that was pushed back from where it was", () => {
    expect(planChipGlide({ left: 40, width: 60 }, { left: 12, width: 60 }, plain)).toEqual({
      dx: 28,
      scaleX: 1,
    });
  });

  it("tweens the surface of a chip that changed width from its old box", () => {
    expect(planChipGlide({ left: 100, width: 80 }, { left: 60, width: 120 }, surface)).toEqual({
      dx: 40,
      scaleX: 80 / 120,
    });
  });

  it("leaves a resized chip without a surface to its content swap", () => {
    expect(planChipGlide({ left: 100, width: 80 }, { left: 60, width: 120 }, plain)).toBeNull();
  });

  it("does not glide on a first measurement, a still chip, or a row that was hidden", () => {
    expect(planChipGlide(undefined, { left: 0, width: 60 }, surface)).toBeNull();
    expect(planChipGlide({ left: 12, width: 60 }, { left: 12.2, width: 60 }, surface)).toBeNull();
    expect(planChipGlide({ left: 0, width: 0 }, { left: 30, width: 60 }, surface)).toBeNull();
    expect(planChipGlide({ left: 30, width: 60 }, { left: 0, width: 0 }, surface)).toBeNull();
  });

  it("snaps under reduced motion", () => {
    expect(
      planChipGlide(
        { left: 40, width: 60 },
        { left: 12, width: 80 },
        {
          hasSurface: true,
          reducedMotion: true,
        },
      ),
    ).toBeNull();
  });
});
