/**
 * Writes ViewCode's copy of the stack-diagram skill where the diagrams guidance points
 * (`STACK_DIAGRAM_SKILL_DIR`). The files are embedded in the bundle so this works in dev, dist,
 * the desktop app and the single executable alike; edit them in `stack-diagram/` and rerun
 * `node scripts/generate-stack-diagram-skill.ts`.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { STACK_DIAGRAM_SKILL_DIR } from "@t3tools/provider-core/server/runtimeInstructions";
import {
  STACK_DIAGRAM_SKILL_FILES,
  STACK_DIAGRAM_SKILL_VERSION,
} from "./stackDiagramSkill.generated.ts";

const VERSION_FILE = ".viewcode-version";

/**
 * Leaves the skill in `dir` at the bundled version. A changed copy is assembled beside it and
 * swapped in by rename, so a turn starting concurrently never reads half a skill.
 */
export const ensureStackDiagramSkill = Effect.fn("StackDiagramSkill.ensure")(function* (
  dir: string = STACK_DIAGRAM_SKILL_DIR,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* fs
    .readFileString(path.join(dir, VERSION_FILE))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (current === STACK_DIAGRAM_SKILL_VERSION) return dir;

  const now = yield* Clock.currentTimeMillis;
  const staging = `${dir}.${process.pid}.${now.toString(36)}.tmp`;
  for (const file of STACK_DIAGRAM_SKILL_FILES) {
    const target = path.join(staging, file.path);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, Buffer.from(file.base64, "base64"));
  }
  yield* fs.writeFileString(path.join(staging, VERSION_FILE), STACK_DIAGRAM_SKILL_VERSION);
  yield* fs.remove(dir, { recursive: true, force: true });
  yield* fs.rename(staging, dir);
  return dir;
});
