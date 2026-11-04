import {
  ThreadGoal,
  ThreadId,
  type OrchestrationV2AppThreadLineage,
  type ViewCodeThreadMetadata,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ViewCodeLegacyThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly parent_thread_id: string | null;
  readonly kind: string | null;
  readonly goal_json: string | null;
  readonly debug_mode: number | null;
}

const decodeGoal = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadGoal));

export function viewCodeLegacyMetadata(row: ViewCodeLegacyThreadRow): ViewCodeThreadMetadata {
  return {
    parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
    kind: row.kind === "sidechat" ? "sidechat" : null,
    viewcodeGoal: row.goal_json === null ? null : Option.getOrNull(decodeGoal(row.goal_json)),
    debugMode: row.debug_mode === 1,
  };
}

export function viewCodeLegacyLineages(
  rows: ReadonlyArray<
    Pick<ViewCodeLegacyThreadRow, "thread_id" | "project_id" | "parent_thread_id" | "kind">
  >,
): ReadonlyMap<string, OrchestrationV2AppThreadLineage> {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  const roots = new Map<string, string | null>();
  for (const row of rows) {
    if (roots.has(row.thread_id)) continue;
    const path: string[] = [];
    const visited = new Set<string>();
    let current = row;
    let root: string | null;
    while (true) {
      if (roots.has(current.thread_id)) {
        root = roots.get(current.thread_id) ?? null;
        break;
      }
      if (visited.has(current.thread_id)) {
        root = null;
        break;
      }
      visited.add(current.thread_id);
      path.push(current.thread_id);
      if (current.parent_thread_id === null) {
        root = current.thread_id;
        break;
      }
      const parent = byId.get(current.parent_thread_id);
      if (parent === undefined || parent.project_id !== current.project_id) {
        root = null;
        break;
      }
      current = parent;
    }
    for (const id of path) roots.set(id, root);
  }
  return new Map(
    rows.map((row) => {
      const root = roots.get(row.thread_id);
      const validParent = root != null && row.parent_thread_id !== null;
      return [
        row.thread_id,
        {
          parentThreadId: validParent ? ThreadId.make(row.parent_thread_id!) : null,
          relationshipToParent: validParent
            ? row.kind === "sidechat"
              ? "fork"
              : "subagent"
            : null,
          rootThreadId: ThreadId.make(root ?? row.thread_id),
        },
      ];
    }),
  );
}
