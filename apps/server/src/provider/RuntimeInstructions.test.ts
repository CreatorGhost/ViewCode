import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the viewcode MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("sends requests to babysit a PR to watch_pull_request instead of polling", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("exposes watch_pull_request, call it and end your turn");
    expect(instructions).toContain("do not poll, sleep, or run your own watcher");
  });

  it("routes requests for sub-agents to visible ViewCode agents by default", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("create ViewCode agents by default");
    expect(instructions).toContain("call viewcode_list_models");
    expect(instructions).toContain("a short task (3 to 8 words");
  });

  it.each(["Codex", "Claude Code", "Cursor", "Grok"])(
    "lets %s fall back to inline sub-agents, announced and without asking",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(
        "as the fallback when viewcode_spawn_agent is missing from your tools or fails",
      );
      expect(instructions).toContain("then proceed without asking");
      expect(instructions).not.toContain("ask whether to use your built-in sub-agents");
      // A provider/model the inline agents cannot honour is reported, never swapped silently.
      expect(instructions).toContain("say so instead of silently substituting");
    },
  );

  it.each(["managed-mcp", "setting"] as const)(
    "does not advertise ViewCode tools when they are unavailable (%s)",
    (reason) => {
      const instructions = buildRuntimeInstructions({
        harness: "Claude Code",
        viewcodeToolsUnavailable: reason,
      });
      expect(instructions).toContain("<runtime_info>");
      expect(instructions).toContain("are not available in this session");
      expect(instructions).not.toContain("<pull_request_linking>");
      expect(instructions).not.toContain("<pull_request_watch>");
      expect(instructions).not.toContain("<viewcode_agents>");
      expect(instructions).not.toContain("call viewcode_list_models");
    },
  );

  it("offers computer use only when granted, with or without ViewCode's MCP tools", () => {
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("viewcode_computer_use");
    for (const viewcodeToolsUnavailable of [undefined, "managed-mcp"] as const) {
      const control = buildRuntimeInstructions({
        harness: "Claude Code",
        viewcodeToolsUnavailable,
        computerUse: "control",
      });
      expect(control).toContain("<viewcode_computer_use>");
      expect(control).toContain("viewcode-computer help");
      expect(control).toContain("Never use osascript");
      expect(control).not.toContain("input actions are unavailable");
    }
    expect(buildRuntimeInstructions({ harness: "Cursor", computerUse: "observe" })).toContain(
      "input actions are unavailable",
    );
  });

  it("offers the browser CLI only when granted, and stops calling the browser unavailable", () => {
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("viewcode_browser");
    const withoutMcp = buildRuntimeInstructions({
      harness: "Claude Code",
      viewcodeToolsUnavailable: "managed-mcp",
      browserCli: true,
    });
    expect(withoutMcp).toContain("<viewcode_browser>");
    expect(withoutMcp).toContain("viewcode-browser help");
    expect(withoutMcp).not.toContain("browser preview,");
    expect(
      buildRuntimeInstructions({ harness: "Claude Code", viewcodeToolsUnavailable: "managed-mcp" }),
    ).toContain("browser preview,");
    expect(buildRuntimeInstructions({ harness: "Cursor", browserCli: true })).toContain(
      "prefer them: they drive the same browser and tab",
    );
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

  it("tells the agent to report missing viewcode tools instead of falling back silently", () => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor" });
    expect(instructions).toContain("If the viewcode_* tools are missing");
    expect(instructions).toContain("name the likely cause");
    expect(instructions).toContain("Cursor team policy may block MCP servers");
    expect(instructions).toContain("sidebar");
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
});
