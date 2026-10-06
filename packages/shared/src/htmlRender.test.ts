import { describe, expect, it } from "vite-plus/test";

import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
} from "./htmlRender.ts";
import { T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";

const reference = { attachmentId: "thread-abc-123-html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it("puts a head after a bare doctype or html tag", () => {
    expect(injectHtmlRenderBootstrap("<!DOCTYPE html><p>x</p>")).toMatch(
      /^<!DOCTYPE html><head><meta charset="utf-8">[\s\S]*<\/head><p>x<\/p>$/,
    );
    expect(injectHtmlRenderBootstrap('<html lang="en"><body>x</body></html>')).toMatch(
      /^<html lang="en"><head>[\s\S]*<\/head><body>x<\/body><\/html>$/,
    );
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderReference", () => {
  it("reads an activity payload and clamps its height and title", () => {
    expect(readHtmlRenderReference(reference)).toEqual(reference);
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(
      HTML_RENDER_MAX_HEIGHT,
    );
    expect(readHtmlRenderReference({ ...reference, height: 1 })?.height).toBe(
      HTML_RENDER_MIN_HEIGHT,
    );
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
  });

  it("rejects malformed payloads", () => {
    expect(readHtmlRenderReference(null)).toBeUndefined();
    expect(readHtmlRenderReference("thread-abc")).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, attachmentId: "" })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, title: undefined })).toBeUndefined();
  });
});

describe("htmlRenderFrameHeight", () => {
  it("starts at the agent's height and then fits the page's reported height", () => {
    expect(htmlRenderFrameHeight(reference)).toBe(420);
    expect(htmlRenderFrameHeight(reference, 912.4)).toBe(912);
    expect(htmlRenderFrameHeight(reference, 20)).toBe(HTML_RENDER_MIN_HEIGHT);
    expect(htmlRenderFrameHeight(reference, 50_000)).toBe(HTML_RENDER_MAX_HEIGHT);
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("reads only the height of an MCP Apps size-changed notification", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params,
    });
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412);
    expect(readHtmlRenderContentHeight(notification({ height: "412" }))).toBeUndefined();
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBeUndefined();
    expect(
      readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: "x" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
    });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand accent as --accent and keeps the fragment decodable", () => {
    const theme = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
    expect(theme.variables["--accent"]).toBe(T3_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-6"]).toBeDefined();
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#t3-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
  });

  it("posts theme changes as an MCP Apps host-context-changed notification", () => {
    const theme = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
    expect(theme.variables["--background"]).toBe(T3_CODE_DARK_THEME_COLORS.canvas);
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderFileName", () => {
  it("drops characters file systems reject", () => {
    expect(htmlRenderFileName('Q3: "revenue" / costs')).toBe("Q3 revenue costs.html");
    expect(htmlRenderFileName("  ")).toBe("Page.html");
  });
});
