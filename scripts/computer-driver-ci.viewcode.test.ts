// @effect-diagnostics nodeBuiltinImport:off - reads upstream-owned CI files to check ViewCode's additions survive a merge.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");

// native/computer-driver is ViewCode's; CI and the change detector are upstream's.
// Dropped from either, the helper's Rust would stop being formatted and tested.
it("CI formats and tests the computer-use helper", () => {
  const loops = read(".github/workflows/ci.yml").match(/for crate in ([^;]+); do/g) ?? [];
  assert.strictEqual(loops.length, 2);
  for (const loop of loops) assert.include(loop, "computer-driver");
});

it("a change to the computer-use helper runs the Rust job", () => {
  const source = read(".github/scripts/ci-changes.cjs");
  const pattern = /const RUST = \/(.+)\/;/.exec(source)?.[1];
  assert.isDefined(pattern);
  assert.isTrue(new RegExp(pattern!).test("native/computer-driver/src/main.rs"));
});

it("pins agent-desktop to one full revision", () => {
  const manifest = read("native/computer-driver/Cargo.toml");
  const revisions = [...manifest.matchAll(/vercel-labs\/agent-desktop", rev = "([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.strictEqual(revisions.length, 2);
  assert.match(revisions[0]!, /^[0-9a-f]{40}$/);
  assert.strictEqual(revisions[1], revisions[0]);
});
