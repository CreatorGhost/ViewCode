import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

// ViewCode's panels slide for 300 ms by default (Synara's duration, on the same
// curve) under the setting `panelAnimationMs`; upstream's `panelAnimationDurationMs`
// is ignored so a saved upstream value cannot turn motion off.
describe("panel animation default", () => {
  it("slides for 300 ms when nothing is saved", () => {
    expect(decodeClientSettings({}).panelAnimationMs).toBe(300);
    expect(decodeClientSettings({ panelAnimationDurationMs: 0 }).panelAnimationMs).toBe(300);
  });

  it("accepts a saved duration from off to the cap", () => {
    expect(decodeClientSettingsPatch({ panelAnimationMs: 0 })).toEqual({ panelAnimationMs: 0 });
    expect(decodeClientSettingsPatch({ panelAnimationMs: 400 })).toEqual({
      panelAnimationMs: 400,
    });
    expect(() => decodeClientSettingsPatch({ panelAnimationMs: 401 })).toThrow();
  });
});
