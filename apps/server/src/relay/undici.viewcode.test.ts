// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// ViewCode guard: undici stays outside the CLI bundle, and a single executable can only reach
// it through require. A static import here makes `build-exe` refuse the bundle.
it("loads undici in the relay through require, never a static import (ViewCode)", () => {
  const files = NodeFS.readdirSync(import.meta.dirname).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "undici.ts",
  );
  const importers = files.filter((name) =>
    /^import(?!\s+type)[^;]*from\s+["']undici["']/m.test(
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8"),
    ),
  );
  expect(importers).toEqual([]);
});
