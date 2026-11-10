// @effect-diagnostics nodeBuiltinImport:off - reads upstream-owned CI files to check ViewCode's additions survive a merge.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createBuildConfig } from "./build-desktop-artifact.ts";
import {
  COMPUTER_DRIVER_EXECUTABLE,
  COMPUTER_DRIVER_RESOURCE_DIR,
  MAC_COMPUTER_DRIVER_EXTRA_RESOURCE,
  MAC_COMPUTER_DRIVER_FILE_EXCLUSIONS,
} from "./lib/viewcode-computer-driver.ts";

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

// The desktop build reuses a cached resource monitor and then has no Rust,
// but the helper is compiled on every macOS build.
it("the macOS release build always has Rust for the computer-use helper", () => {
  const setup = /- name: Setup Rust\n\s+if: (.+)\n/.exec(
    read(".github/workflows/release-desktop.yml"),
  )?.[1];
  assert.isDefined(setup);
  assert.include(setup!, "inputs.platform == 'mac'");
});

it("the server looks for the helper where the desktop build puts it", () => {
  const server = read("apps/server/src/computerUse/AgentDesktopComputerDriver.ts");
  assert.include(server, `"../../${COMPUTER_DRIVER_RESOURCE_DIR}"`);
  assert.include(server, `"${COMPUTER_DRIVER_EXECUTABLE}"`);
  assert.include(
    read("native/computer-driver/Cargo.toml"),
    `name = "${COMPUTER_DRIVER_EXECUTABLE}"`,
  );
});

it("credits the agent-desktop revision the helper is built from", () => {
  const revision = /vercel-labs\/agent-desktop", rev = "([^"]+)"/.exec(
    read("native/computer-driver/Cargo.toml"),
  )?.[1];
  assert.isDefined(revision);
  const notices = JSON.parse(read("third-party-licenses.config.json")) as {
    customNotices: ReadonlyArray<{ name: string; license: string; generatedNotices?: unknown }>;
  };
  const notice = notices.customNotices.find((entry) => entry.name === "agent-desktop");
  assert.strictEqual(notice?.license, "Apache-2.0");
  assert.include(JSON.stringify(notice?.generatedNotices), revision!);
});

// The helper is ViewCode's; the desktop build script it is staged from is upstream's.
it.layer(NodeServices.layer)("desktop build hooks", (it) => {
  it.effect("ships the helper in the Mac app only, once, outside app.asar", () =>
    Effect.gen(function* () {
      const config = (platform: "mac" | "linux" | "win", target: string) =>
        createBuildConfig(platform, target, "1.2.3", false, false, undefined, undefined).pipe(
          Effect.map(
            (built) =>
              built as { extraResources: ReadonlyArray<unknown>; files: ReadonlyArray<string> },
          ),
        );
      const mac = yield* config("mac", "dmg");
      assert.deepInclude(mac.extraResources, MAC_COMPUTER_DRIVER_EXTRA_RESOURCE);
      assert.includeMembers([...mac.files], [...MAC_COMPUTER_DRIVER_FILE_EXCLUSIONS]);
      for (const other of [yield* config("linux", "AppImage"), yield* config("win", "nsis")]) {
        assert.notDeepInclude(other.extraResources, MAC_COMPUTER_DRIVER_EXTRA_RESOURCE);
      }
    }),
  );
});

it("the desktop build stages the helper for the Mac app", () => {
  assert.match(
    read("scripts/build-desktop-artifact.ts"),
    /if \(options\.platform === "mac"\) \{\s+yield\* stageComputerDriver\(\{/,
  );
});
