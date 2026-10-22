import type {
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { fileBasename } from "@t3tools/shared/path";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? catalogModel.shortName || catalogModel.name
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

// Reports often open with a markdown heading and bold labels; a one-line preview
// shows their text, not the syntax.
function plainMarkdownLine(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gmu, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const result = input.result?.trim();
  const progress = input.progress?.trim();
  const detail =
    (isTerminalSubagentStatus(input.status) ? result || progress : progress || result) || "";
  const compact = plainMarkdownLine(detail);
  return compact.length > 280 ? `${compact.slice(0, 280).trimEnd()}…` : compact || null;
}

/** One spawned agent's state as its row in the thinking log shows it. */
export type SubagentRowState =
  | "working"
  | "waiting"
  | "queued"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "idle";

/** A paused agent (agent control's Stop) reads as paused whatever its last turn did. */
export function subagentRowState(
  status: OrchestrationV2TurnItemStatus,
  control?: { readonly paused: boolean } | undefined,
): SubagentRowState {
  if (control?.paused) return "paused";
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

export function subagentRowStateLabel(
  state: SubagentRowState,
  control?: { readonly queued: number } | undefined,
): string {
  if (state === "paused") {
    const queued = control?.queued ?? 0;
    return queued > 0 ? `paused · ${queued} queued` : "paused";
  }
  return state;
}

/** The states that still move: the row reads in the live colour, not the finished one. */
export function subagentRowIsActive(state: SubagentRowState): boolean {
  return state === "working" || state === "waiting" || state === "queued" || state === "paused";
}

const ROW_STATE_ORDER: ReadonlyArray<SubagentRowState> = [
  "working",
  "waiting",
  "queued",
  "paused",
  "done",
  "failed",
  "stopped",
  "idle",
];

/** "4 working · 1 done · 1 failed": how many of a spawn's agents are in each state. */
export function summarizeSubagentRowStates(states: ReadonlyArray<SubagentRowState>): string {
  const counts = new Map<SubagentRowState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return ROW_STATE_ORDER.flatMap((state) => {
    const count = counts.get(state);
    return count ? [`${count} ${state}`] : [];
  }).join(" · ");
}

export function spawnedAgentsHeading(count: number): string {
  return `Spawned ${count} ${count === 1 ? "agent" : "agents"}`;
}

/** Rows a spawn lists before the rest fold into "+N more"; at this size or less, all show. */
export const MAX_VISIBLE_AGENT_ROWS = 8;

export function visibleAgentRows<Agent>(
  agents: ReadonlyArray<Agent>,
  limit = MAX_VISIBLE_AGENT_ROWS,
): { readonly visible: ReadonlyArray<Agent>; readonly hidden: number } {
  if (agents.length <= limit) return { visible: agents, hidden: 0 };
  const visible = agents.slice(0, limit - 1);
  return { visible, hidden: agents.length - visible.length };
}

/** The spawn's rail marker: live while any agent works, a dead end if one failed, else merged. */
export function spawnedAgentsMarker(
  states: ReadonlyArray<SubagentRowState>,
): "live" | "dead-end" | "merged" {
  if (states.some((state) => state === "working")) return "live";
  if (states.some((state) => state === "failed")) return "dead-end";
  return "merged";
}
