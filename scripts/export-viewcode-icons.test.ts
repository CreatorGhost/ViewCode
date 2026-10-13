import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import sharp from "sharp";

import { renderProductionIcons } from "./export-viewcode-icons.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const loadIcons = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  return yield* renderProductionIcons(root);
});

function icon(icons: Map<string, Buffer>, path: string) {
  const contents = icons.get(path);
  assert.isDefined(contents);
  return contents!;
}

it.layer(NodeServices.layer)("ViewCode production icons", (it) => {
  it.effect("makes iOS and apple-touch icons opaque and full bleed on the near-black tile", () =>
    Effect.gen(function* () {
      const icons = yield* loadIcons;
      yield* Effect.promise(async () => {
        for (const [path, size] of [
          [BRAND_ASSET_PATHS.productionIosIconPng, 1024],
          [BRAND_ASSET_PATHS.productionWebAppleTouchIconPng, 180],
        ] as const) {
          const metadata = await sharp(icon(icons, path)).metadata();
          assert.equal(metadata.width, size);
          assert.equal(metadata.height, size);
          assert.isFalse(metadata.hasAlpha);
          const corner = await sharp(icon(icons, path))
            .extract({ left: 0, top: 0, width: 1, height: 1 })
            .raw()
            .toBuffer();
          // Near-black tile edge, not a white flatten showing through.
          for (const channel of corner) assert.isBelow(channel, 24);
        }
      });
    }),
  );

  it.effect("keeps Android artwork inside the guaranteed adaptive-icon circle", () =>
    Effect.gen(function* () {
      const icons = yield* loadIcons;
      yield* Effect.promise(async () => {
        const { data, info } = await sharp(
          icon(icons, "apps/mobile/assets/android-icon-foreground-prod.png"),
        )
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 432);
        assert.equal(info.height, 432);
        assert.equal(info.channels, 4);
        let painted = 0;
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3]! < 16) continue;
            painted++;
            assert.isAtMost(Math.hypot(x + 0.5 - 216, y + 0.5 - 216), 132);
          }
        }
        assert.isAbove(painted, 0);
      });
    }),
  );

  it.effect("preserves all three hollow git nodes in the monochrome emblem", () =>
    Effect.gen(function* () {
      const icons = yield* loadIcons;
      yield* Effect.promise(async () => {
        const image = icon(icons, "apps/mobile/assets/android-icon-mark-prod.png");
        for (const [left, top] of [
          [199, 193],
          [240, 202],
          [216, 258],
        ]) {
          const pixel = await sharp(image)
            .extract({ left: left!, top: top!, width: 1, height: 1 })
            .raw()
            .toBuffer();
          assert.equal(pixel[3], 0);
        }
      });
    }),
  );

  it.effect("makes notification and themed icons single-color silhouettes", () =>
    Effect.gen(function* () {
      const icons = yield* loadIcons;
      yield* Effect.promise(async () => {
        for (const path of [
          "apps/mobile/assets/android-icon-mark-prod.png",
          "apps/mobile/assets/android-notification-icon-prod.png",
        ]) {
          const { data } = await sharp(icon(icons, path))
            .raw()
            .toBuffer({ resolveWithObject: true });
          let painted = 0;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3] === 0) continue;
            painted++;
            assert.deepEqual([...data.subarray(index, index + 3)], [255, 255, 255]);
          }
          assert.isAbove(painted, 0);
        }
      });
    }),
  );
});
