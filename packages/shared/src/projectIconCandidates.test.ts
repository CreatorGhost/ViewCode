import { describe, expect, it } from "vite-plus/test";

import {
  iconPathsFromProjectConfig,
  iconPathsFromReadme,
  iconPathsFromWebManifest,
  isSkippedIconDirectory,
  projectIconFamilyKey,
  rankProjectIconPaths,
  scoreProjectIconPath,
} from "./projectIconCandidates.ts";

describe("rankProjectIconPaths", () => {
  it("finds a monorepo app's favicon among unrelated images", () => {
    expect(
      rankProjectIconPaths([
        "apps/web/src/assets/hero.png",
        "apps/web/public/favicon.svg",
        "apps/web/public/screenshots/home.png",
        "docs/images/architecture.png",
      ]),
    ).toEqual(["apps/web/public/favicon.svg"]);
  });

  it("prefers the project's own mark over a monorepo app's", () => {
    expect(
      rankProjectIconPaths(["apps/docs/public/favicon.ico", "public/logo.svg"], { limit: 1 }),
    ).toEqual(["public/logo.svg"]);
  });

  it("orders favicon before icon before logo, and offers an svg over its png", () => {
    expect(
      rankProjectIconPaths([
        "static/logo.png",
        "static/icon.png",
        "static/favicon.png",
        "static/favicon.svg",
      ]),
    ).toEqual(["static/favicon.svg", "static/icon.png", "static/logo.png"]);
  });

  it("finds Tauri's size-named icons and offers them as one image", () => {
    expect(
      rankProjectIconPaths([
        "src-tauri/icons/16x16.png",
        "src-tauri/icons/128x128.png",
        "src-tauri/icons/icon.png",
      ]),
    ).toEqual(["src-tauri/icons/icon.png"]);
    expect(
      rankProjectIconPaths(["src-tauri/icons/16x16.png", "src-tauri/icons/128x128.png"]),
    ).toEqual(["src-tauri/icons/128x128.png"]);
  });

  it("offers one copy of an image, but keeps its light and dark versions", () => {
    expect(
      rankProjectIconPaths([
        "public/pwa-192x192.png",
        "public/pwa-512x512.png",
        "assets/logo.svg",
        "assets/logo.png",
        "assets/logo-dark.svg",
      ]),
    ).toEqual(["assets/logo.svg", "assets/logo-dark.svg", "public/pwa-512x512.png"]);
  });

  it("matches an image named after the project", () => {
    expect(
      rankProjectIconPaths(["assets/slicerninja.svg"], { projectName: "SlicerNinja" }),
    ).toEqual(["assets/slicerninja.svg"]);
  });

  it("ignores tool logos, dependencies, tests and non-images", () => {
    expect(
      rankProjectIconPaths([
        "src/assets/react.svg",
        "public/vite-logo.svg",
        "node_modules/pkg/logo.svg",
        "tests/fixtures/favicon.ico",
        ".next/static/favicon.ico",
        "src/logo.ts",
      ]),
    ).toEqual([]);
  });
});

describe("scoreProjectIconPath", () => {
  it("strips size and appearance variants from the name", () => {
    expect(scoreProjectIconPath("public/favicon-32x32.png")).not.toBeNull();
    expect(scoreProjectIconPath("assets/logo-dark.svg")).not.toBeNull();
    expect(scoreProjectIconPath("public/favicon-16x16.png")!).toBeLessThan(
      scoreProjectIconPath("public/favicon-32x32.png")!,
    );
  });

  it("accepts Windows separators", () => {
    expect(scoreProjectIconPath("public\\favicon.ico")).toBe(
      scoreProjectIconPath("public/favicon.ico"),
    );
  });
});

describe("projectIconFamilyKey", () => {
  it("leaves sizes and the extension out of an image's identity", () => {
    expect(projectIconFamilyKey("public/favicon-32x32.png")).toBe(
      projectIconFamilyKey("public/favicon.svg"),
    );
    expect(projectIconFamilyKey("icons/128x128.png")).toBe("icons/icon");
    expect(projectIconFamilyKey("logo-dark.svg")).not.toBe(projectIconFamilyKey("logo.svg"));
  });
});

describe("isSkippedIconDirectory", () => {
  it("walks .github but not other dot folders or dependencies", () => {
    expect(isSkippedIconDirectory(".github")).toBe(false);
    expect(isSkippedIconDirectory(".git")).toBe(true);
    expect(isSkippedIconDirectory("node_modules")).toBe(true);
    expect(isSkippedIconDirectory("public")).toBe(false);
  });
});

describe("declared icons", () => {
  it("reads the README's logo but not its banner or badges", () => {
    const readme = [
      '<p align="center"><img src="./docs/banner.png" alt="Banner"></p>',
      '<img src="docs/assets/logo.svg" alt="SlicerNinja" width="80">',
      "[![CI](https://img.shields.io/badge/ci-passing.svg)](https://ci)",
      "![Screenshot](./docs/screenshot.png)",
    ].join("\n");
    expect(iconPathsFromReadme(readme)).toEqual(["docs/assets/logo.svg"]);
  });

  it("reads a web manifest's icons, largest first", () => {
    expect(
      iconPathsFromWebManifest(
        JSON.stringify({
          icons: [
            { src: "/icon-192.png", sizes: "192x192" },
            { src: "/icon-512.png", sizes: "512x512" },
            { src: "https://cdn.example.com/remote.png", sizes: "1024x1024" },
          ],
        }),
      ),
    ).toEqual(["icon-512.png", "icon-192.png"]);
  });

  it("reads package.json, Expo and Tauri icon declarations", () => {
    expect(iconPathsFromProjectConfig(JSON.stringify({ icon: "images/icon.png" }))).toEqual([
      "images/icon.png",
    ]);
    expect(
      iconPathsFromProjectConfig(JSON.stringify({ expo: { icon: "./assets/icon.png" } })),
    ).toEqual(["assets/icon.png"]);
    expect(
      iconPathsFromProjectConfig(
        JSON.stringify({ bundle: { icon: ["icons/32x32.png", "icons/128x128.png"] } }),
      ),
    ).toEqual(["icons/128x128.png", "icons/32x32.png"]);
    expect(iconPathsFromProjectConfig("not json")).toEqual([]);
  });
});
