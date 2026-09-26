// @effect-diagnostics nodeBuiltinImport:off - Shell build bootstrap entry point.
import * as NodePath from "node:path";

import { assertBuildStateIdle, resolveBuildState } from "./lib/build-state.ts";

const [command, mode] = process.argv.slice(2);
if ((command !== "resolve" && command !== "check") || (mode !== "web" && mode !== "desktop")) {
  throw new Error("Usage: node scripts/build-state.ts <resolve|check> <web|desktop>");
}
try {
  const paths = await resolveBuildState({
    mode,
    repoRoot: NodePath.resolve(import.meta.dirname, ".."),
  });
  if (command === "check") {
    assertBuildStateIdle([paths.baseDir, paths.profileDir]);
  } else {
    const values = [paths.baseDir, paths.stateDir, paths.profileDir];
    if (values.some((value) => /[\r\n]/.test(value))) {
      throw new Error("Build paths cannot contain newlines.");
    }
    process.stdout.write(values.join("\n") + "\n");
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
