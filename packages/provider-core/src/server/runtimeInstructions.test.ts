import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_CLI_GUIDANCE,
  buildRuntimeInstructions,
  VIEWCODE_DIAGRAMS_GUIDANCE,
  VIEWCODE_DRAFTS_GUIDANCE,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("tells every session how diagrams and drafts render, without needing MCP", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });
    expect(instructions).toContain(`<viewcode_diagrams>\n${VIEWCODE_DIAGRAMS_GUIDANCE}`);
    expect(instructions).toContain(`<viewcode_drafts>\n${VIEWCODE_DRAFTS_GUIDANCE}`);
  });

  it("offers the browser CLI only to a session that has it", () => {
    expect(buildRuntimeInstructions({ harness: "Grok" })).not.toContain("viewcode-browser");
    expect(buildRuntimeInstructions({ harness: "Grok", browserCli: true })).toContain(
      `<viewcode_browser>\n${BROWSER_CLI_GUIDANCE}`,
    );
  });

  it("leaves the guidance blocks to a caller that sends them as separate entries", () => {
    const instructions = buildRuntimeInstructions(
      { harness: "Codex", browserCli: true },
      { separateEntries: true },
    );
    expect(instructions).toContain("<runtime_info>");
    expect(instructions).not.toContain("viewcode_diagrams");
    expect(instructions).not.toContain("viewcode_drafts");
    expect(instructions).not.toContain("viewcode-browser");
  });
});
