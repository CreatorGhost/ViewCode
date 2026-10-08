import { describe, expect, it } from "vite-plus/test";

import {
  chunkSpeakableBlocks,
  latestReadableReply,
  naturalVoiceStatus,
  planReadAloud,
  playChunksAhead,
  ReadAloudChunkError,
  readAloudChunks,
  readAloudVoiceChoices,
  resolveReadAloudVoice,
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

describe("natural voice selection", () => {
  const natural = { engine: "kokoro", voice: "af_heart", tier: "small" } as const;

  it("defaults to the natural voice and keeps a chosen system voice", () => {
    expect(resolveReadAloudVoice(null)).toEqual(natural);
    const system = { engine: "system", voiceURI: "Samantha" } as const;
    expect(resolveReadAloudVoice(system)).toBe(system);
  });

  it("reads the tier's phase, or unavailable when the environment has no voice models", () => {
    const state = {
      tiers: [{ tier: "small", phase: "ready", downloadedBytes: 1, totalBytes: 1, message: null }],
    } as const;
    expect(naturalVoiceStatus(state, "small")).toBe("ready");
    expect(naturalVoiceStatus(state, "large")).toBe("unavailable");
    expect(naturalVoiceStatus(null, "small")).toBe("unavailable");
  });

  it.each([
    ["ready", { engine: "natural", startDownload: false, notice: null }],
    ["absent", { engine: "system", startDownload: true, notice: "downloading" }],
    ["downloading", { engine: "system", startDownload: false, notice: "downloading" }],
    ["failed", { engine: "system", startDownload: false, notice: "failed" }],
    ["unavailable", { engine: "system", startDownload: false, notice: "unavailable" }],
  ] as const)("plans a %s natural voice", (status, plan) => {
    expect(planReadAloud({ voice: natural, natural: status, systemAvailable: true })).toEqual(plan);
  });

  it("still starts the download when no system voice can fill in", () => {
    expect(planReadAloud({ voice: natural, natural: "absent", systemAvailable: false })).toEqual({
      engine: null,
      startDownload: true,
      notice: "downloading",
    });
  });

  it("never touches the natural voice for a chosen system voice", () => {
    const system = { engine: "system", voiceURI: null } as const;
    expect(planReadAloud({ voice: system, natural: "absent", systemAvailable: true })).toEqual({
      engine: "system",
      startDownload: false,
      notice: null,
    });
  });
});

describe("playChunksAhead", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  /** A fake engine that records what happens in order and lets the test finish each step. */
  function fakeEngine() {
    const log: string[] = [];
    const syntheses = new Map<string, ReturnType<typeof deferred<string>>>();
    const plays = new Map<string, ReturnType<typeof deferred<void>>>();
    return {
      log,
      synthesize: (text: string) => {
        log.push(`synthesize ${text}`);
        const step = deferred<string>();
        syntheses.set(text, step);
        return step.promise;
      },
      play: (clip: string) => {
        log.push(`play ${clip}`);
        const step = deferred<void>();
        plays.set(clip, step);
        return step.promise;
      },
      synthesized: (text: string) => syntheses.get(text)!.resolve(`clip ${text}`),
      failed: (text: string) => syntheses.get(text)!.reject(new Error("synthesis failed")),
      played: (clip: string) => plays.get(clip)!.resolve(),
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("synthesizes the next chunk while the current one plays, one ahead", async () => {
    const engine = fakeEngine();
    const done = playChunksAhead(["one", "two", "three"], {
      ...engine,
      signal: new AbortController().signal,
    });
    await settle();
    expect(engine.log).toEqual(["synthesize one"]);
    engine.synthesized("one");
    await settle();
    expect(engine.log).toEqual(["synthesize one", "synthesize two", "play clip one"]);
    engine.synthesized("two");
    await settle();
    // Two is ready, but three waits until two starts playing.
    expect(engine.log).toHaveLength(3);
    engine.played("clip one");
    await settle();
    expect(engine.log.slice(3)).toEqual(["synthesize three", "play clip two"]);
    engine.synthesized("three");
    engine.played("clip two");
    await settle();
    engine.played("clip three");
    await done;
    expect(engine.log.at(-1)).toBe("play clip three");
  });

  it("stops playing and drops pending synthesis when aborted", async () => {
    const engine = fakeEngine();
    const controller = new AbortController();
    const done = playChunksAhead(["one", "two", "three"], { ...engine, signal: controller.signal });
    engine.synthesized("one");
    await settle();
    controller.abort();
    engine.played("clip one");
    engine.failed("two");
    await done;
    expect(engine.log).toEqual(["synthesize one", "synthesize two", "play clip one"]);
  });

  it("reports which chunk could not be synthesized", async () => {
    const engine = fakeEngine();
    const done = playChunksAhead(["one", "two"], {
      ...engine,
      signal: new AbortController().signal,
    });
    engine.synthesized("one");
    await settle();
    engine.failed("two");
    engine.played("clip one");
    const error = await done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadAloudChunkError);
    expect((error as ReadAloudChunkError).chunkIndex).toBe(1);
  });
});
