#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

export class ViewCodeIconRenderError extends Schema.TaggedError<ViewCodeIconRenderError>()(
  "ViewCodeIconRenderError",
  { cause: Schema.Defect() },
) {}

const canvas = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${body}</svg>`;

/** Platform masks are applied once: full bleed for iOS, safe margins for macOS and Android. */
export async function renderViewCodeIcons(source: string) {
  const svg = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  // The mark and its cut retain the master's 1024-unit geometry; only the tile is stripped.
  const mark = svg.replace(/<rect\b[^>]*\brx="\d+"[^>]*\/>/g, "");
  const rasterize = (body: string, size: number, opaque = false) => {
    const image = sharp(Buffer.from(canvas(1024, body))).resize(size, size);
    return (opaque ? image.flatten({ background: "#161614" }).removeAlpha() : image)
      .png()
      .toBuffer();
  };
  const square = `<rect width="1024" height="1024" fill="#161614"/>${mark}`;
  const ios = await rasterize(square, 1024, true);
  const tile = await rasterize(svg, 1024);
  // Preserve the classic macOS 824px body inset 100px in a 1024px canvas.
  const mac = await rasterize(
    `<defs><filter id="shadow" x="-25%" y="-25%" width="150%" height="160%"><feGaussianBlur stdDeviation="12"/></filter></defs><rect x="100" y="112" width="824" height="824" rx="184" fill="black" opacity=".24" filter="url(#shadow)"/><g transform="translate(100 100) scale(.8046875)">${svg}</g>`,
    1024,
  );
  const renditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await rasterize(svg, size) })),
  );
  const ico = encodePngIco(renditions);
  const outputs = new Map<string, Buffer>([
    ["assets/viewcode-icon-512.png", await rasterize(svg, 512)],
    [BRAND_ASSET_PATHS.productionIosIconPng, ios],
    [BRAND_ASSET_PATHS.productionMacIconPng, mac],
    [BRAND_ASSET_PATHS.productionLinuxIconPng, tile],
    [BRAND_ASSET_PATHS.productionWindowsIconIco, ico],
    [BRAND_ASSET_PATHS.productionWebFaviconIco, ico],
    [BRAND_ASSET_PATHS.productionWebFavicon16Png, await rasterize(svg, 16)],
    [BRAND_ASSET_PATHS.productionWebFavicon32Png, await rasterize(svg, 32)],
    [BRAND_ASSET_PATHS.productionWebAppleTouchIconPng, await rasterize(square, 180, true)],
  ]);
  for (const directory of ["apps/web/public", "apps/marketing/public"]) {
    for (const override of resolveWebIconOverrides("production", directory)) {
      const contents = outputs.get(override.sourceRelativePath);
      if (contents === undefined)
        throw new Error(`Missing icon source: ${override.sourceRelativePath}`);
      outputs.set(override.targetRelativePath, contents);
    }
  }
  // 108dp at xxxhdpi. Scale the tile mark by 72/108 to preserve its proportions after masking.
  // Center on the mark's bounds, rather than its 1024-unit source canvas.
  const adaptiveMark = `<g transform="translate(512 512) scale(.6666667) translate(-512 -518)">${mark}</g>`;
  // A notification/themed icon is the same V in one color, including its cut.
  const silhouette = mark
    .replace(/<path\b[^>]*\bstroke-opacity="[^"]*"[^>]*\/>/g, "")
    .replace(/stroke="#[^"]*"/g, 'stroke="white"');
  const adaptiveSilhouette = `<g transform="translate(512 512) scale(.6666667) translate(-512 -518)">${silhouette}</g>`;
  outputs.set(
    "apps/mobile/assets/android-icon-foreground-prod.png",
    await rasterize(adaptiveMark, 432),
  );
  outputs.set(
    "apps/mobile/assets/android-icon-mark-prod.png",
    await rasterize(adaptiveSilhouette, 432),
  );
  outputs.set(
    "apps/mobile/assets/android-notification-icon-prod.png",
    await rasterize(adaptiveSilhouette, 96),
  );
  outputs.set(
    "apps/mobile/assets/android-splash-icon-prod.png",
    await rasterize(`<rect width="1024" height="1024" fill="#161614"/>${adaptiveMark}`, 1152, true),
  );
  return outputs;
}

export const renderProductionIcons = Effect.fn("viewcodeIcons.renderProductionIcons")(function* (
  repositoryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(path.join(repositoryRoot, "assets/viewcode-icon.svg"));
  return yield* Effect.tryPromise({
    try: () => renderViewCodeIcons(source),
    catch: (cause) => new ViewCodeIconRenderError({ cause }),
  });
});

if (import.meta.main) {
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    const outputs = yield* renderProductionIcons(root);
    for (const [file, contents] of outputs) {
      yield* fs.writeFile(path.join(root, file), contents);
      yield* Console.log(`wrote ${file}`);
    }
  }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
