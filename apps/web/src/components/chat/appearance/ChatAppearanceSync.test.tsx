import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ settings: {} as ClientSettings }));
vi.mock("../../../hooks/useSettings", () => ({
  useClientSettings: <A,>(select: (settings: ClientSettings) => A) => select(state.settings),
}));
import { ChatAppearanceSync } from "./ChatAppearanceSync";

let renderer: ReactTestRenderer | undefined;
let dataset: Record<string, string>;
beforeEach(() => {
  state.settings = { ...DEFAULT_CLIENT_SETTINGS, chatDensity: "compact", composerGlow: false };
  dataset = { chatWidth: "wide" };
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("applies saved density and glow, and supports reversing both without changing native width", async () => {
  await act(async () => {
    renderer = create(<ChatAppearanceSync />);
  });
  expect(dataset).toEqual({ chatWidth: "wide", chatDensity: "compact", composerGlow: "off" });

  dataset.chatWidth = "full";
  state.settings = { ...state.settings, chatDensity: "comfortable", composerGlow: true };
  await act(async () => renderer?.update(<ChatAppearanceSync />));
  expect(dataset).toEqual({ chatWidth: "full", chatDensity: "comfortable", composerGlow: "on" });
});
