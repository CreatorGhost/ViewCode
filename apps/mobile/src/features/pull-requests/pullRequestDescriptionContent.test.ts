import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

describe("PR attachments", () => {
  it("deduplicates embedded images in the retained native description", () => {
    const uri = "https://drop.example.com/shot.png";
    const document: MarkdownNode = {
      type: "document",
      children: [
        { type: "image", href: uri, alt: "Screenshot" },
        { type: "image", href: uri, alt: "Duplicate" },
      ],
    };
    expect(pullRequestDescriptionContent(document).attachments).toEqual([
      { uri, caption: "Screenshot" },
    ]);
  });

  // Video detection remains shared; ViewCode retains its image-only native attachment gallery.
  it("detects image and video media independently of the retained gallery", () => {
    const uri = "https://drop.example.com/shot.png";
    expect(
      splitPullRequestBody(
        `${uri}\n\nhttps://drop.example.com/demo.mp4\n\nhttps://github.com/user-attachments/assets/123-abc`,
      ),
    ).toEqual([
      { id: "attachment:0", kind: "attachment", url: uri, media: "image" },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://drop.example.com/demo.mp4",
        media: "video",
      },
      {
        id: "attachment:2",
        kind: "attachment",
        url: "https://github.com/user-attachments/assets/123-abc",
        media: "video",
      },
    ]);
  });

  it("does not collect ordinary links or media examples in code", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "link",
          href: "https://example.com/docs",
          children: [{ type: "text", content: "Docs" }],
        },
        { type: "code_block", content: "![Example](https://drop.example.com/image.png)" },
        { type: "code_inline", content: '<img src="https://drop.example.com/inline.png">' },
        { type: "html_block", content: "<!-- ![Hidden](https://drop.example.com/hidden.png) -->" },
      ],
    };
    expect(pullRequestDescriptionContent(document).attachments).toEqual([]);
    expect(
      splitPullRequestBody(
        "https://example.com/docs\n\n```\nhttps://drop.example.com/demo.mp4\n```",
      ),
    ).toEqual([
      {
        id: "markdown:0",
        kind: "markdown",
        text: "https://example.com/docs\n\n```\nhttps://drop.example.com/demo.mp4\n```",
      },
    ]);
  });

  it("keeps nested native screenshots ordered and rejects local or executable sources", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "blockquote",
          children: [{ type: "image", href: "https://example.com/first.png", title: "First" }],
        },
        {
          type: "list",
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [
                    { type: "image", href: "https://example.com/second.png", alt: "Second" },
                    { type: "image", href: "https://example.com/first.png", alt: "Duplicate" },
                    { type: "image", href: "file:///private/image.png" },
                    { type: "image", href: "javascript:alert(1)" },
                    { type: "image", href: "data:image/png;base64,private" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(pullRequestDescriptionContent(document).attachments).toEqual([
      { uri: "https://example.com/first.png", caption: "First" },
      { uri: "https://example.com/second.png", caption: "Second" },
    ]);
  });
});
