import { describe, expect, it } from "vite-plus/test";

import {
  LOOK_MIGRATION_KEY,
  migrateToViewCodeLook,
  undoViewCodeLookMigration,
} from "./viewcodeLookMigration";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("migrateToViewCodeLook", () => {
  it("switches an upstream theme to ViewCode once, and undo restores it", () => {
    const storage = memoryStorage({
      "t3code:theme": "ocean",
      "t3code:theme-halves:v1": '{"light":"grove"}',
    });
    expect(migrateToViewCodeLook(storage)).toBe(true);
    expect(storage.getItem("t3code:theme")).toBe("viewcode");
    expect(storage.getItem("t3code:theme-halves:v1")).toBeNull();
    expect(migrateToViewCodeLook(storage)).toBe(false);

    undoViewCodeLookMigration(storage);
    expect(storage.getItem("t3code:theme")).toBe("ocean");
    expect(storage.getItem("t3code:theme-halves:v1")).toBe('{"light":"grove"}');
  });

  it("leaves ViewCode themes and fresh profiles alone", () => {
    const named = memoryStorage({ "t3code:theme": "viewcode-nord" });
    expect(migrateToViewCodeLook(named)).toBe(false);
    expect(named.getItem("t3code:theme")).toBe("viewcode-nord");

    const fresh = memoryStorage();
    expect(migrateToViewCodeLook(fresh)).toBe(false);
    expect(fresh.getItem("t3code:theme")).toBeNull();
    expect(fresh.getItem(LOOK_MIGRATION_KEY)).toBe("1");
  });

  it("never runs again after a user picks an upstream theme later", () => {
    const storage = memoryStorage({ [LOOK_MIGRATION_KEY]: "1", "t3code:theme": "ember" });
    expect(migrateToViewCodeLook(storage)).toBe(false);
    expect(storage.getItem("t3code:theme")).toBe("ember");
  });
});
