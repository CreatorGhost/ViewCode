import {
  type OrchestrationThreadActivity,
  ViewcodeToolsUnavailableDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The thread notice for a Claude chat that runs without ViewCode's own tools,
 * either because the organization manages Claude Code's MCP servers or because
 * the user turned them off. The server records it as a `runtime.warning`
 * activity whose detail is `ViewcodeToolsUnavailableDetail`; unmanaged chats
 * never get one.
 */
export interface ViewcodeToolsNotice {
  readonly reason: ViewcodeToolsUnavailableDetail["reason"];
  /** Stable per thread and reason, for remembering a dismissal. */
  readonly key: string;
  readonly text: string;
  readonly why: string;
}

const decodeDetail = Schema.decodeUnknownOption(ViewcodeToolsUnavailableDetail);

const NOTICE_WHY = {
  "managed-mcp":
    "This computer has an enterprise MCP configuration for Claude Code (managed-mcp.json), installed by your organization. With it in place, Claude Code only loads the MCP servers your organization lists and refuses any server an app adds, including ViewCode's. ViewCode respects that policy and runs Claude without its own tools. To use them, ask your IT team to add ViewCode's MCP server to the managed configuration.",
  setting:
    "“Run Claude without ViewCode tools” is on in Settings → Providers → Claude, so ViewCode starts Claude without its own tool server. Turn it off to bring the tools back in new Claude sessions.",
} as const;

export function deriveViewcodeToolsNotice(input: {
  readonly threadId: string;
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>;
  /** The thread's current session provider; the notice is about Claude only. */
  readonly sessionProviderName: string | null | undefined;
}): ViewcodeToolsNotice | null {
  if (input.sessionProviderName != null && input.sessionProviderName !== "claudeAgent") {
    return null;
  }
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index]!;
    if (activity.kind !== "runtime.warning") continue;
    const payload = activity.payload as
      | { readonly message?: unknown; readonly detail?: unknown }
      | null
      | undefined;
    const detail = decodeDetail(payload?.detail);
    if (Option.isNone(detail) || typeof payload?.message !== "string") continue;
    const reason = detail.value.reason;
    return {
      reason,
      key: `viewcode-tools:${input.threadId}:${reason}`,
      // The server words the notice; only the explanation lives here.
      text: payload.message,
      why: NOTICE_WHY[reason],
    };
  }
  return null;
}
