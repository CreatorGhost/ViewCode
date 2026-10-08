import { describe, expect, it } from "vite-plus/test";

import {
  chunkSpeakableBlocks,
  latestReadableReply,
  readAloudChunks,
  readAloudVoiceChoices,
  speakableBlocksFromMarkdown,
} from "./readAloud.logic";

describe("speakableBlocksFromMarkdown", () => {
  it("reads prose and skips code blocks and mermaid diagrams", () => {
    const markdown = [
      "Here is the fix:",
      "```ts",
      "const answer = 42;",
      "```",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "Run `vp test` afterwards",
    ].join("\n\n");

    expect(speakableBlocksFromMarkdown(markdown)).toEqual([
      "Here is the fix:",
      "Code block skipped.",
      "Code block skipped.",
      "Run vp test afterwards.",
    ]);
  });

  it("reads links as their text, never their URL, and drops images", () => {
    expect(
      speakableBlocksFromMarkdown(
        "See [the docs](https://example.com/docs) or https://example.com/raw. ![diagram](a.png) Done.",
      ),
    ).toEqual(["See the docs or link. Done."]);
  });

  it("strips heading, list and emphasis markup", () => {
    const markdown = "## Summary\n\n- **Fast** start\n- _Small_ bundle\n\n1. First step\n2. Second";
    expect(speakableBlocksFromMarkdown(markdown)).toEqual([
      "Summary.",
      "Fast start.",
      "Small bundle.",
      "First step.",
      "Second.",
    ]);
  });

  it("reads table rows as comma-separated cells", () => {
    const markdown = "| Name | Size |\n| --- | --- |\n| web | `12 kB` |";
    expect(speakableBlocksFromMarkdown(markdown)).toEqual(["Name, Size.", "web, 12 kB."]);
  });

  it("reads GitHub alerts by their label and skips raw HTML and rules", () => {
    const markdown = "> [!WARNING]\n> This deletes data.\n\n---\n\n<details>hidden</details>";
    expect(speakableBlocksFromMarkdown(markdown)).toEqual(["Warning. This deletes data."]);
  });
});

describe("chunkSpeakableBlocks", () => {
  it("packs whole sentences up to the limit", () => {
    expect(chunkSpeakableBlocks(["One two. Three four.", "Five six."], 20)).toEqual([
      "One two. Three four.",
      "Five six.",
    ]);
  });

  it("keeps decimals and versions inside one sentence", () => {
    expect(chunkSpeakableBlocks(["Version 1.5 is out. Upgrade now."], 22)).toEqual([
      "Version 1.5 is out.",
      "Upgrade now.",
    ]);
  });

  it("splits an overlong sentence at clauses, then words, then characters", () => {
    expect(chunkSpeakableBlocks(["alpha beta, gamma delta epsilon"], 12)).toEqual([
      "alpha beta,",
      "gamma delta",
      "epsilon",
    ]);
    expect(chunkSpeakableBlocks(["abcdefghij"], 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never exceeds the limit for a long reply", () => {
    const reply = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} is here.`);
    const chunks = readAloudChunks(reply.join(" "));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(250);
    expect(chunks.join(" ")).toBe(reply.join(" "));
  });
});

describe("latestReadableReply", () => {
  const message = (
    id: string,
    role: "user" | "assistant",
    text: string,
    turnId: string | null,
    streaming = false,
  ) => ({ id, role, text, turnId, streaming, createdAt: "", updatedAt: "" });

  it("picks the last settled reply, not progress updates of a running turn", () => {
    const thread = {
      messages: [
        message("u1", "user", "hi", null),
        message("a1", "assistant", "Done with the first task.", "t1"),
        message("u2", "user", "next", null),
        message("a2", "assistant", "Looking at the files now.", "t2"),
      ],
      latestTurn: { turnId: "t2", state: "running", startedAt: "", completedAt: null },
      session: null,
    } as unknown as Parameters<typeof latestReadableReply>[0];

    expect(latestReadableReply(thread)?.id).toBe("a1");
  });

  it("picks the final message once the turn settles and skips streaming text", () => {
    const settled = {
      messages: [
        message("a1", "assistant", "Update.", "t1"),
        message("a2", "assistant", "Final.", "t1"),
      ],
      latestTurn: { turnId: "t1", state: "completed", startedAt: "", completedAt: "now" },
      session: null,
    } as unknown as Parameters<typeof latestReadableReply>[0];
    expect(latestReadableReply(settled)?.id).toBe("a2");

    const streaming = {
      ...settled,
      messages: [message("a3", "assistant", "Partial", null, true)],
    } as unknown as Parameters<typeof latestReadableReply>[0];
    expect(latestReadableReply(streaming)).toBeNull();
  });
});

describe("readAloudVoiceChoices", () => {
  const voice = (voiceURI: string, lang: string) => ({ voiceURI, name: voiceURI, lang });
  const voices = [voice("Thomas", "fr-FR"), voice("Daniel", "en-GB"), voice("Samantha", "en-US")];

  it("lists the user's language with their exact locale first, keeping the saved voice", () => {
    expect(readAloudVoiceChoices(voices, "en-US", "Thomas").map((each) => each.voiceURI)).toEqual([
      "Samantha",
      "Daniel",
      "Thomas",
    ]);
  });

  it("falls back to every voice when none speaks the user's language", () => {
    expect(readAloudVoiceChoices(voices, "ja-JP", null)).toHaveLength(3);
  });
});
