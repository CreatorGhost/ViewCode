import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vitest";

import { withFastMode } from "./ModelFastModeToggle";

const claude = ProviderDriverKind.make("claudeAgent");
const model = (slug: string, fast: boolean): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: fast ? [{ id: "fastMode", label: "Fast Mode", type: "boolean" }] : [],
  }),
});
const models = [model("opus", true), model("haiku", false)];
const instance = ProviderInstanceId.make("claudeAgent");

describe("withFastMode", () => {
  it("sets the model's fast-mode option and keeps the others", () => {
    const selection = createModelSelection(instance, "opus", [{ id: "effort", value: "high" }]);
    expect(withFastMode(selection, claude, models, true)?.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const on = withFastMode(selection, claude, models, true)!;
    expect(withFastMode(on, claude, models, false)?.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: false },
    ]);
  });

  it("offers nothing for a model without fast mode", () => {
    expect(withFastMode(createModelSelection(instance, "haiku"), claude, models, true)).toBeNull();
    expect(
      withFastMode(createModelSelection(instance, "unknown"), claude, models, true),
    ).toBeNull();
  });
});
