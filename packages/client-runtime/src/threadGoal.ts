/**
 * ViewCode's own thread slash commands (`/goal`, `/debug`, `/default`), shared by the web and
 * mobile composers so both parse and apply them the same way. They change thread state through
 * `thread.meta.update`; nothing is sent to the agent.
 */
import { THREAD_GOAL_MAX_CHARS, type ThreadGoal } from "@t3tools/contracts";

export const THREAD_SLASH_COMMANDS = [
  { command: "goal", description: "Set, edit, pause, resume or clear this thread's goal" },
  { command: "debug", description: "Switch this thread into evidence-first debug mode" },
] as const;

/** Provider commands of these names are hidden where ViewCode offers its own. */
export const APP_OWNED_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "goal",
  "debug",
  "default",
]);

export type GoalCommandAction =
  | { readonly action: "edit" }
  | { readonly action: "set"; readonly objective: string }
  | { readonly action: "pause" }
  | { readonly action: "resume" }
  | { readonly action: "clear" }
  | { readonly action: "too-long" };

export type ThreadSlashCommand =
  | { readonly command: "goal"; readonly goal: GoalCommandAction }
  | { readonly command: "debug" }
  | { readonly command: "default" };

/**
 * `/goal` alone opens the editor; `pause`, `resume` and `clear` control the goal; anything else
 * is the new objective. `/goal -- pause` sets a goal that is literally "pause".
 */
export function parseGoalCommandArgs(args: string): GoalCommandAction {
  const trimmed = args.trim();
  const literal = /^--(?:\s|$)/.test(trimmed);
  const objective = literal ? trimmed.slice(2).trim() : trimmed;
  if (objective === "") return { action: "edit" };
  if (!literal) {
    const control = objective.toLowerCase();
    if (control === "pause" || control === "resume" || control === "clear") {
      return { action: control };
    }
  }
  return objective.length > THREAD_GOAL_MAX_CHARS
    ? { action: "too-long" }
    : { action: "set", objective };
}

/** A whole message that is one of ViewCode's thread commands, or null. */
export function parseThreadSlashCommand(text: string): ThreadSlashCommand | null {
  const match = /^\/(goal|debug|default)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = match[1]!.toLowerCase();
  const args = match[2] ?? "";
  if (command === "goal") return { command: "goal", goal: parseGoalCommandArgs(args) };
  if (args.trim() !== "") return null;
  return command === "debug" ? { command: "debug" } : { command: "default" };
}

/** The `thread.meta.update` fields for a goal command; null for one that changes nothing. */
export function threadGoalUpdate(
  action: GoalCommandAction,
): { readonly goal?: string | null; readonly goalPaused?: boolean } | null {
  switch (action.action) {
    case "set":
      // A goal the user just typed is one they want worked on now.
      return { goal: action.objective, goalPaused: false };
    case "pause":
      return { goalPaused: true };
    case "resume":
      return { goalPaused: false };
    case "clear":
      return { goal: null };
    case "edit":
    case "too-long":
      return null;
  }
}

export function isThreadGoalPaused(goal: ThreadGoal | null | undefined): boolean {
  return goal != null && goal.pausedAt !== null;
}
