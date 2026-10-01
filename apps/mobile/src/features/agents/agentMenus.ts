import type {
  AgentControlAvailability,
  AgentTreeControlSummary,
} from "@t3tools/client-runtime/state/child-agents";
import type { MenuAction } from "@react-native-menu/menu";

/** Menu event ids for agent control; every id starts with `agents:`. */
export const AGENT_MENU_EVENT = {
  stop: "agents:stop",
  resume: "agents:resume",
  discard: "agents:discard",
  stopAll: "agents:stop-all",
  resumeAll: "agents:resume-all",
  discardAll: "agents:discard-all",
} as const;

export type AgentMenuEvent = (typeof AGENT_MENU_EVENT)[keyof typeof AGENT_MENU_EVENT];

const AGENT_MENU_EVENTS = new Set<string>(Object.values(AGENT_MENU_EVENT));

export function isAgentMenuEvent(event: string): event is AgentMenuEvent {
  return AGENT_MENU_EVENTS.has(event);
}

/** A child agent's long-press menu: what it can do right now. */
export function buildChildAgentMenuActions(availability: AgentControlAvailability): MenuAction[] {
  return [
    ...(availability.stop
      ? [{ id: AGENT_MENU_EVENT.stop, title: "Stop agent", image: "stop.fill" }]
      : []),
    ...(availability.resume
      ? [{ id: AGENT_MENU_EVENT.resume, title: "Resume agent", image: "play" }]
      : []),
    ...(availability.discard
      ? [
          {
            id: AGENT_MENU_EVENT.discard,
            title: "Discard held messages",
            image: "trash",
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
}

const leadMenuCache = new Map<string, MenuAction[]>();
const NO_ACTIONS: MenuAction[] = [];

/**
 * Tree-wide items for a lead thread's menu. Cached by counts so a memoized
 * row keeps the same array until the tree's state actually moves.
 */
export function buildLeadAgentMenuActions(summary: AgentTreeControlSummary | null): MenuAction[] {
  if (summary === null) return NO_ACTIONS;
  const key = `${summary.running}:${summary.paused}:${summary.queued}`;
  const cached = leadMenuCache.get(key);
  if (cached) return cached;
  const actions: MenuAction[] = [
    ...(summary.running > 0
      ? [
          {
            id: AGENT_MENU_EVENT.stopAll,
            title: `Stop all agents (${summary.running} running)`,
            image: "stop.fill",
          },
        ]
      : []),
    ...(summary.paused > 0
      ? [
          {
            id: AGENT_MENU_EVENT.resumeAll,
            title: summary.paused === 1 ? "Resume stopped agent" : "Resume stopped agents",
            image: "play",
          },
        ]
      : []),
    ...(summary.paused > 0 || summary.queued > 0
      ? [
          {
            id: AGENT_MENU_EVENT.discardAll,
            title: "Discard held agent messages",
            image: "trash",
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
  const result = actions.length === 0 ? NO_ACTIONS : actions;
  leadMenuCache.set(key, result);
  return result;
}

/** What a paused (stopped by the user) agent shows in place of its status. */
export function pausedAgentLabel(queued: number): string {
  return queued > 0 ? `paused · ${queued} queued` : "paused";
}
