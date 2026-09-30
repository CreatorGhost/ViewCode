import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  modelChipLabel,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});

describe("modelChipLabel", () => {
  const CLAUDE_CAPABILITIES: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
      },
    ],
  };

  it("names the context window variant, the default until one is picked", () => {
    expect(
      modelChipLabel({
        label: "Claude Opus 5.5",
        capabilities: CLAUDE_CAPABILITIES,
        selections: [],
      }),
    ).toBe("Claude Opus 5.5 · 1M");
    expect(
      modelChipLabel({
        label: "Claude Opus 5.5",
        capabilities: CLAUDE_CAPABILITIES,
        selections: [{ id: "contextWindow", value: "200k" }],
      }),
    ).toBe("Claude Opus 5.5 · 200k");
  });

  it("is the bare model name for a model without window variants", () => {
    expect(
      modelChipLabel({ label: "GPT-5", capabilities: CODEX_CAPABILITIES, selections: [] }),
    ).toBe("GPT-5");
  });
});
