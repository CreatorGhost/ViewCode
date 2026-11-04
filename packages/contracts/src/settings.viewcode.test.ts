import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

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

// Speak mode is a server setting so the server knows to write spoken summaries,
// and every client of the environment shares it. Nothing speaks until a user
// turns it on.
describe("speak mode", () => {
  it("is off when nothing is saved", () => {
    expect(decodeServerSettings({}).speakMode).toBe("off");
  });

  it("is set through the server settings patch", () => {
    expect(decodeServerSettingsPatch({ speakMode: "summary" })).toEqual({ speakMode: "summary" });
    expect(decodeServerSettingsPatch({ speakMode: "full" })).toEqual({ speakMode: "full" });
    expect(() => decodeServerSettingsPatch({ speakMode: "loud" })).toThrow();
  });
});
