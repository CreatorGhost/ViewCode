import { describe, expect, it } from "vite-plus/test";

import { replyToSpeak, speakableText, speechChunks, spokenTextForReply } from "./speakableText";

describe("speakableText", () => {
  it("skips code and diagrams and keeps the prose around them", () => {
    const markdown = [
      "## Fixed the **build**",
      "",
      "The `vp` binary was missing. See [the docs](https://example.com/docs).",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "~~~mermaid",
      "flowchart LR",
      "  A --> B",
      "~~~",
      "",
      "- First step",
      "- [x] Second step",
      "",
      "> Note: done.",
    ].join("\n");
    expect(speakableText(markdown)).toBe(
      [
        "Fixed the build",
        "The vp binary was missing. See the docs.",
        "Code block skipped.",
        "Code block skipped.",
        "First step Second step",
        "Note: done.",
      ].join("\n\n"),
    );
  });

  it("does not end a fence on a shorter or different marker", () => {
    expect(speakableText("````md\n```js\nx\n```\n````\nAfter.")).toBe(
      "Code block skipped.\n\nAfter.",
    );
  });

  it("reads table rows as lists and drops images, HTML and rules", () => {
    expect(
      speakableText(
        "| Area | Files |\n| --- | --- |\n| Speech | speech.ts |\n| Docs | README.md |\n\n---\n![shot](a.png) <br/>Done",
      ),
    ).toBe("Area, Files\n\nSpeech, speech.ts\n\nDocs, README.md\n\nDone");
  });
});

describe("speechChunks", () => {
  it("keeps every piece under the platform limit, split at words", () => {
    const chunks = speechChunks(`${"word ".repeat(30)}\n\nShort.`, 40);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(`${"word ".repeat(30).trim()} Short.`);
  });
});

describe("speak mode", () => {
  const reply = { id: "m1", text: "Done.\n\n```sh\nrm -rf x\n```" };

  it("reads the summary in summary mode, and waits until it arrives", () => {
    expect(replyToSpeak({ mode: "summary", reply, handledId: null })).toBeNull();
    expect(
      replyToSpeak({
        mode: "summary",
        reply: { ...reply, spokenSummary: "Fixed it." },
        handledId: null,
      }),
    ).toEqual({ id: "m1", text: "Fixed it." });
  });

  it("reads the whole reply without code in full mode", () => {
    expect(spokenTextForReply("full", reply)).toBe("Done.\n\nCode block skipped.");
  });

  it("never reads a reply twice, or anything when off", () => {
    expect(replyToSpeak({ mode: "full", reply, handledId: "m1" })).toBeNull();
    expect(replyToSpeak({ mode: "off", reply, handledId: null })).toBeNull();
    expect(replyToSpeak({ mode: "full", reply: null, handledId: null })).toBeNull();
  });
});
