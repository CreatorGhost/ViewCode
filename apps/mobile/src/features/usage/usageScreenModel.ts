import {
  type AgentControlState,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatResumeAt } from "@t3tools/shared/usageLimit";
import {
  type LimitPresentations,
  NO_USAGE_RECORDED_NOTICE,
  limitsNotice,
} from "@t3tools/shared/usageLimits";

/** "Command Code", "Cursor", …; an unknown driver keeps its id rather than vanishing. */
export function limitDriverLabel(driver: ServerProvider["driver"]): string {
  return PROVIDER_DISPLAY_NAMES[driver] ?? String(driver);
}

export interface ProviderAwaitingData {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly label: string;
}

/**
 * Providers that report limits but have not produced a reading yet. The
 * Limits tab lists them plainly as "No data yet" instead of raising a warning:
 * nothing is wrong, the computer simply has not seen any usage.
 */
export function providersAwaitingData(
  presentations: LimitPresentations,
): ReadonlyArray<ProviderAwaitingData> {
  const labelEnvironment = presentations.size > 1;
  const rows: ProviderAwaitingData[] = [];
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
      if (
        !provider.usageLimits ||
        limitsNotice(provider.usageLimits) !== NO_USAGE_RECORDED_NOTICE
      ) {
        continue;
      }
      const name = provider.displayName?.trim() || limitDriverLabel(provider.driver);
      rows.push({
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        label: labelEnvironment ? `${name} · ${presentation.entry.target.label}` : name,
      });
    }
  }
  return rows;
}

/** Warnings worth a banner: everything except "no usage yet", which has its own quiet row. */
export function limitWarnings(notices: ReadonlyArray<string>): ReadonlyArray<string> {
  return notices.filter((notice) => !notice.endsWith(NO_USAGE_RECORDED_NOTICE));
}

export interface UsageResumeRow {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly text: string;
  readonly resumeAt: string | null;
}

/**
 * Threads a usage limit stopped, from each computer's agent-control stream:
 * the ones that resume by themselves first, soonest first, then the ones
 * waiting for the user. Threads the phone has no title for (archived, not yet
 * loaded) still appear, so a scheduled resume is never hidden.
 */
export function usageResumeRows(input: {
  readonly control: ReadonlyMap<string, AgentControlState>;
  readonly titleOf: (environmentId: string, threadId: string) => string | null;
  readonly nowMs: number;
  readonly locale?: string;
}): ReadonlyArray<UsageResumeRow> {
  const rows: UsageResumeRow[] = [];
  for (const [key, state] of input.control) {
    if (!state.usageResume) continue;
    const environmentId = key.slice(0, key.length - state.threadId.length - 1);
    const resumeAt = state.usageResume.resumeAt ?? null;
    rows.push({
      key,
      environmentId,
      threadId: state.threadId,
      title: input.titleOf(environmentId, state.threadId) ?? "Untitled thread",
      text:
        resumeAt === null
          ? "Out of usage · send a message to continue"
          : `Resumes ${formatResumeAt(resumeAt, input.nowMs, input.locale)}`,
      resumeAt,
    });
  }
  return rows.sort((left, right) => {
    if (left.resumeAt === null || right.resumeAt === null) {
      return left.resumeAt === right.resumeAt
        ? left.title.localeCompare(right.title)
        : left.resumeAt === null
          ? 1
          : -1;
    }
    return Date.parse(left.resumeAt) - Date.parse(right.resumeAt);
  });
}

/**
 * What the Usage loading state is waiting on. Transcript scans need a live
 * connection, so while every pending environment is disconnected the screen says
 * so instead of claiming to scan.
 */
export function usageLoadingCaption(
  pending: ReadonlyArray<{ readonly label: string; readonly isConnected: boolean }>,
): { readonly caption: string; readonly waitingForConnection: boolean } {
  const disconnected = pending.filter((environment) => !environment.isConnected);
  if (disconnected.length === 0 || disconnected.length < pending.length) {
    return { caption: "Scanning provider transcripts…", waitingForConnection: false };
  }
  return {
    caption:
      disconnected.length === 1
        ? `Waiting for ${disconnected[0]!.label} to connect…`
        : `Waiting for ${disconnected.length} environments to connect…`,
    waitingForConnection: true,
  };
}
