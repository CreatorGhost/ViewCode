import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DIRECT_PUSH_PREFERENCES,
  directPushRegistrationKey,
  directPushWantsAnything,
  planDirectPushSync,
  resolveDirectPushPreferences,
  setDirectPushCategory,
} from "./directPush";

const TOKEN = "ExponentPushToken[abc]";

describe("resolveDirectPushPreferences", () => {
  it("starts off with every category on, and fills in categories an older build did not store", () => {
    expect(resolveDirectPushPreferences(undefined)).toEqual(DEFAULT_DIRECT_PUSH_PREFERENCES);
    expect(
      resolveDirectPushPreferences({ enabled: true, categories: { finished: false, bogus: 1 } }),
    ).toEqual({
      enabled: true,
      categories: { finished: false, needsYou: true, usageLimit: true, resumed: true },
    });
    expect(resolveDirectPushPreferences({ enabled: "yes" }).enabled).toBe(false);
  });
});

describe("category toggles", () => {
  it("changes one category and treats all-off as off", () => {
    const on = { ...DEFAULT_DIRECT_PUSH_PREFERENCES, enabled: true };
    const noFinished = setDirectPushCategory(on, "finished", false);
    expect(noFinished.categories).toEqual({
      finished: false,
      needsYou: true,
      usageLimit: true,
      resumed: true,
    });
    expect(directPushWantsAnything(noFinished)).toBe(true);
    const none = (["needsYou", "usageLimit", "resumed"] as const).reduce(
      (preferences, category) => setDirectPushCategory(preferences, category, false),
      noFinished,
    );
    expect(directPushWantsAnything(none)).toBe(false);
    expect(directPushWantsAnything(DEFAULT_DIRECT_PUSH_PREFERENCES)).toBe(false);
  });

  it("gives each set of categories its own registration key", () => {
    const all = DEFAULT_DIRECT_PUSH_PREFERENCES.categories;
    expect(directPushRegistrationKey(TOKEN, all)).not.toBe(
      directPushRegistrationKey(TOKEN, { ...all, resumed: false }),
    );
  });
});

describe("planDirectPushSync", () => {
  const key = directPushRegistrationKey(TOKEN, DEFAULT_DIRECT_PUSH_PREFERENCES.categories);

  it("registers with computers that were not told yet, or were told something else", () => {
    expect(
      planDirectPushSync({
        desired: { key },
        everEnabled: true,
        connected: ["a", "b", "c"],
        synced: new Map([
          ["a", key],
          ["b", "old"],
          ["c", null],
        ]),
      }),
    ).toEqual({ register: ["b", "c"], unregister: [] });
  });

  it("tells computers to forget the phone once when notifications are off", () => {
    expect(
      planDirectPushSync({
        desired: null,
        everEnabled: true,
        connected: ["a", "b", "c"],
        synced: new Map([
          ["a", key],
          ["b", null],
        ]),
      }),
    ).toEqual({ register: [], unregister: ["a", "c"] });
  });

  it("sends nothing from a phone that never turned notifications on", () => {
    expect(
      planDirectPushSync({
        desired: null,
        everEnabled: false,
        connected: ["a"],
        synced: new Map(),
      }),
    ).toEqual({ register: [], unregister: [] });
  });
});
