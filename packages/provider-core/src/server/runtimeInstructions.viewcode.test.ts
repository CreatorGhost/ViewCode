// @effect-diagnostics nodeBuiltinImport:off - joins a path for an assertion, no Effect runtime.
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  STACK_DIAGRAM_SKILL_DIR,
  VIEWCODE_DIAGRAMS_GUIDANCE,
  buildRuntimeInstructions,
} from "./runtimeInstructions.ts";

// ViewCode guard: architecture diagrams with real logos go through the bundled stack-diagram
// skill, and every session is told where it is. Mermaid stays the default for the rest.
it("points every session at the stack-diagram skill (ViewCode)", () => {
  const skill = NodePath.join(STACK_DIAGRAM_SKILL_DIR, "SKILL.md");
  expect(VIEWCODE_DIAGRAMS_GUIDANCE).toContain(skill);
  expect(VIEWCODE_DIAGRAMS_GUIDANCE).toContain("```mermaid");
  expect(buildRuntimeInstructions({ harness: "Claude Code" })).toContain(skill);
});
