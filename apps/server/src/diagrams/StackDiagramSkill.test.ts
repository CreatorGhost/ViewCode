// @effect-diagnostics nodeBuiltinImport:off - reads the skill's source files and the generated module, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  readSkillFiles,
  renderGeneratedModule,
} from "../../../../scripts/generate-stack-diagram-skill.ts";
import { ensureStackDiagramSkill } from "./StackDiagramSkill.ts";
import {
  STACK_DIAGRAM_SKILL_FILES,
  STACK_DIAGRAM_SKILL_VERSION,
} from "./stackDiagramSkill.generated.ts";

it("keeps the embedded skill in step with its source files", () => {
  const generated = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "stackDiagramSkill.generated.ts"),
    "utf8",
  );
  assert.strictEqual(
    generated,
    renderGeneratedModule(readSkillFiles()),
    "run `node scripts/generate-stack-diagram-skill.ts` after editing stack-diagram/",
  );
});

it("ships no way to post diagrams to the public gallery", () => {
  const paths = STACK_DIAGRAM_SKILL_FILES.map((file) => file.path);
  assert.notInclude(paths, "scripts/share.py");
  const skill = Buffer.from(
    STACK_DIAGRAM_SKILL_FILES.find((file) => file.path === "SKILL.md")!.base64,
    "base64",
  ).toString("utf8");
  assert.notMatch(skill, /share\.py|stacks\.caru\.moe/);
});

it.effect("writes the skill once and replaces a stale copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-diagram-" });
    const dir = NodePath.join(root, "stack-diagram");

    yield* ensureStackDiagramSkill(dir);
    for (const file of STACK_DIAGRAM_SKILL_FILES) {
      const written = yield* fs.readFile(NodePath.join(dir, file.path));
      assert.strictEqual(Buffer.from(written).toString("base64"), file.base64, file.path);
    }

    // Current: left alone.
    yield* fs.writeFileString(NodePath.join(dir, "kept.txt"), "x");
    yield* ensureStackDiagramSkill(dir);
    assert.isTrue(yield* fs.exists(NodePath.join(dir, "kept.txt")));

    // Stale: replaced whole, so files the old copy had are gone.
    yield* fs.writeFileString(NodePath.join(dir, ".viewcode-version"), "old");
    yield* ensureStackDiagramSkill(dir);
    assert.isFalse(yield* fs.exists(NodePath.join(dir, "kept.txt")));
    assert.strictEqual(
      yield* fs.readFileString(NodePath.join(dir, ".viewcode-version")),
      STACK_DIAGRAM_SKILL_VERSION,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("never loads libraries from a shared folder or turns off Chromium's sandbox", () => {
  const renderer = Buffer.from(
    STACK_DIAGRAM_SKILL_FILES.find((file) => file.path === "scripts/render_png.py")!.base64,
    "base64",
  ).toString("utf8");
  assert.notMatch(renderer, /\/tmp\/|LD_LIBRARY_PATH|--no-sandbox/);
});
