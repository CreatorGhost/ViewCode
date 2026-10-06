import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "./HtmlRender.ts";

const testLayer = HtmlRender.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-render-" })),
  Layer.provideMerge(NodeServices.layer),
);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("HtmlRender", () => {
  it.effect("inlines local images by absolute path and leaves URLs and relative paths alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const png = path.join(directory, "shot.png");
      const svg = path.join(directory, "logo.svg");
      yield* fileSystem.writeFile(png, PNG_BYTES);
      yield* fileSystem.writeFileString(svg, "<svg/>");
      const kept = [
        "https://example.com/a.png",
        "//cdn.example.com/b.png",
        "./c.png",
        "data:image/png;base64,AAAA",
      ];

      const prepared = yield* htmlRender.prepare(
        [
          "<!doctype html><html><head><title>Shots</title></head><body>",
          `<img src="${png}"><div style="background:url(${svg})"></div>`,
          `<script>const shots = ['${png}', \`${svg}\`];</script>`,
          ...kept.map((src) => `<img src="${src}">`),
          "</body></html>",
        ].join(""),
      );

      const pngUri = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
      const svgUri = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
      expect(prepared).toContain(`<img src="${pngUri}">`);
      expect(prepared).toContain(`url(${svgUri})`);
      expect(prepared).toContain(`['${pngUri}', \`${svgUri}\`]`);
      expect(prepared).not.toContain(directory);
      for (const src of kept) expect(prepared).toContain(`<img src="${src}">`);
      // The theme bootstrap opens the head, ahead of the page's own markup.
      expect(prepared.indexOf("<head>")).toBeLessThan(prepared.indexOf('<style id="t3-theme">'));
      expect(prepared.indexOf('<style id="t3-theme">')).toBeLessThan(prepared.indexOf("<title>"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses files that are not images, whatever they are named", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const folder = path.join(directory, "folder.png");
      yield* fileSystem.makeDirectory(folder);
      const missing = path.join(directory, "missing.jpg");
      // Named like an image, but a symlink or renamed file must not carry other data.
      const secret = path.join(directory, "secret.png");
      yield* fileSystem.writeFileString(secret, "API_KEY=abc123");
      const linked = path.join(directory, "linked.png");
      yield* fileSystem.symlink(secret, linked);
      const report = path.join(directory, "report.svg");
      yield* fileSystem.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      // An <svg> inside a quoted entity is not the root element.
      const config = path.join(directory, "config.svg");
      yield* fileSystem.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );

      const error = yield* htmlRender
        .prepare(
          [missing, folder, secret, linked, report, config]
            .map((src) => `<img src="${src}">`)
            .join(""),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(HtmlRender.HtmlRenderImagesNotFoundError);
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([
        missing,
        folder,
        secret,
        linked,
        report,
        config,
      ]);
      expect(error.message).not.toContain("abc123");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("caps each image and the whole page", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-html-images-" });
      const sizedPng = Effect.fn(function* (name: string, size: number) {
        const file = path.join(directory, name);
        yield* fileSystem.writeFile(file, PNG_BYTES);
        yield* fileSystem.truncate(file, size);
        return file;
      });

      const huge = yield* sizedPng("huge.png", HtmlRender.HTML_RENDER_MAX_IMAGE_BYTES + 1);
      const tooLarge = yield* htmlRender.prepare(`<img src="${huge}">`).pipe(Effect.flip);
      expect(tooLarge).toBeInstanceOf(HtmlRender.HtmlRenderImageTooLargeError);
      expect(tooLarge._tag === "HtmlRenderImageTooLargeError" && tooLarge.path).toBe(huge);

      // Each fits, but three of them base64-encoded do not fit one page.
      const big = Math.floor(HtmlRender.HTML_RENDER_MAX_IMAGE_BYTES * 0.9);
      const images = yield* Effect.forEach(["a.png", "b.png", "c.png"], (name) =>
        sizedPng(name, big),
      );
      const pageTooLarge = yield* htmlRender
        .prepare(images.map((src) => `<img src="${src}">`).join(""))
        .pipe(Effect.flip);
      expect(pageTooLarge).toBeInstanceOf(HtmlRender.HtmlRenderPageTooLargeError);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("publishes the prepared page as an html thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const htmlRender = yield* HtmlRender.HtmlRender;

      const { reference, filePath } = yield* htmlRender.publish({
        threadId: ThreadId.make("thread-html-render"),
        html: "<p>Quarterly revenue</p>",
        title: "  Revenue  ",
        height: 9_000,
      });

      expect(reference).toEqual({
        attachmentId: expect.stringMatching(/^thread-html-render-[0-9a-f-]{36}-html$/),
        title: "Revenue",
        height: 2_000,
      });
      const stored = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: reference.attachmentId,
      });
      expect(stored).toBe(filePath);
      const html = yield* fileSystem.readFileString(filePath);
      expect(html).toContain('<style id="t3-theme">');
      expect(html).toContain("<p>Quarterly revenue</p>");
    }).pipe(Effect.provide(testLayer)),
  );
});
