import { formatContextWindowTokens } from "../../lib/contextWindow";
import type { WorkLogEntry } from "../../session-logic";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

type HandoffInfo = NonNullable<WorkLogEntry["handoff"]>;

/** What the divider knows about a provider instance, from the server provider list. */
export interface HandoffInstanceInfo {
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly models: ReadonlyArray<ModelEsque>;
}

export interface HandoffEndpointView {
  readonly driver: string | null;
  readonly providerName: string | null;
  readonly modelName: string;
  /** Shown in the collapsed divider: the model, or the account when the model did not change. */
  readonly collapsedName: string;
}

export interface HandoffView {
  readonly header: string;
  readonly from: HandoffEndpointView;
  readonly to: HandoffEndpointView;
  readonly contextLabel: string | null;
  readonly charCount: number | null;
}

function endpoint(
  model: string,
  instanceId: string | undefined,
  instances: ReadonlyMap<string, HandoffInstanceInfo>,
): Omit<HandoffEndpointView, "collapsedName"> {
  const info = instanceId ? instances.get(instanceId) : undefined;
  const found = info?.models.find((entry) => entry.slug === model);
  return {
    driver: info?.driver ?? null,
    providerName: info ? (info.displayName ?? info.driver) : (instanceId ?? null),
    modelName: found ? getTriggerDisplayModelName(found) : model,
  };
}

/** Header text: a recovery notice, a side chat's own label, or the plain handoff title. */
export function handoffHeader(label: string, recovery: boolean | undefined): string {
  if (recovery) return "Session restarted with a recap";
  if (label.startsWith("Context handed off")) return "Context handoff";
  return label;
}

/**
 * "Condensed · ~50k of ~180k tokens" from the server's estimates; the sizes
 * are absent on handoffs recorded before they were stamped, which keep the
 * bare mode label.
 */
function handoffContextLabel(handoff: HandoffInfo): string | null {
  if (!handoff.mode) return null;
  const { carriedTokens, conversationTokens } = handoff;
  if (handoff.mode === "full") {
    return carriedTokens === undefined
      ? "Carried in full"
      : `Carried in full · ~${formatContextWindowTokens(carriedTokens)} tokens`;
  }
  return carriedTokens === undefined || conversationTokens === undefined
    ? "Condensed"
    : `Condensed · ~${formatContextWindowTokens(carriedTokens)} of ~${formatContextWindowTokens(conversationTokens)} tokens`;
}

/**
 * Null when the activity predates the payload (no model pair), so the caller
 * falls back to the plain label.
 */
export function resolveHandoffView(
  entry: Pick<WorkLogEntry, "label"> & { readonly handoff?: HandoffInfo | undefined },
  instances: ReadonlyMap<string, HandoffInstanceInfo>,
): HandoffView | null {
  const handoff = entry.handoff;
  if (!handoff) return null;
  const from = endpoint(handoff.fromModel, handoff.fromInstanceId, instances);
  const to = endpoint(handoff.toModel, handoff.toInstanceId, instances);
  const showAccounts =
    handoff.fromModel === handoff.toModel &&
    from.providerName !== null &&
    to.providerName !== null &&
    handoff.fromInstanceId !== handoff.toInstanceId;
  const name = (side: typeof from) =>
    showAccounts ? (side.providerName ?? side.modelName) : side.modelName;
  return {
    header: handoffHeader(entry.label, handoff.recovery),
    from: { ...from, collapsedName: name(from) },
    to: { ...to, collapsedName: name(to) },
    contextLabel: handoffContextLabel(handoff),
    charCount: handoff.summary ? handoff.summary.length : null,
  };
}
