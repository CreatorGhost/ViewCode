/**
 * ViewCode's own thread slash commands (`/goal`, `/debug`, `/default`), shared by the web and
 * mobile composers so both parse and apply them the same way. They change thread state through
 * `thread.meta.update`; only `/goal run` sends a message, the same visible one as the Run goal
 * controls.
 */
import { THREAD_GOAL_MAX_CHARS, type ThreadGoal } from "@t3tools/contracts";

export const THREAD_SLASH_COMMANDS = [
  { command: "goal", description: "Set, edit, run, pause, resume or clear this thread's goal" },
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
  | { readonly action: "run" }
  | { readonly action: "pause" }
  | { readonly action: "resume" }
  | { readonly action: "clear" }
  | { readonly action: "too-long" };

export type ThreadSlashCommand =
  | { readonly command: "goal"; readonly goal: GoalCommandAction }
  | { readonly command: "debug" }
  | { readonly command: "default" };

/**
 * `/goal` alone opens the editor; `run`, `pause`, `resume` and `clear` control the goal; anything
 * else is the new objective. `/goal -- pause` sets a goal that is literally "pause".
 */
export function parseGoalCommandArgs(args: string): GoalCommandAction {
  const trimmed = args.trim();
  const literal = /^--(?:\s|$)/.test(trimmed);
  const objective = literal ? trimmed.slice(2).trim() : trimmed;
  if (objective === "") return { action: "edit" };
  if (!literal) {
    const control = objective.toLowerCase();
    if (control === "run" || control === "pause" || control === "resume" || control === "clear") {
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
    case "run":
    case "too-long":
      return null;
  }
}

export function isThreadGoalPaused(goal: ThreadGoal | null | undefined): boolean {
  return goal != null && goal.pausedAt !== null;
}

/**
 * The visible user message that starts a turn toward the goal. A goal guides every turn but never
 * starts one, so Run goal sends this rather than a hidden prompt.
 */
export const THREAD_GOAL_START_MESSAGE = "Start working on the goal.";
export const THREAD_GOAL_CONTINUE_MESSAGE = "Continue working on the goal.";

/** "Start" on a thread without messages or for a goal just written; "Continue" otherwise. */
export function threadGoalRunMessage(input: {
  readonly hasMessages: boolean;
  readonly goalChanged: boolean;
}): string {
  return input.hasMessages && !input.goalChanged
    ? THREAD_GOAL_CONTINUE_MESSAGE
    : THREAD_GOAL_START_MESSAGE;
}

/**
 * What names a thread whose first message is a goal run: the goal itself, since the run message
 * says nothing about the work. Null for any other first message, which is titled as usual.
 */
export function threadGoalRunTitle(input: {
  readonly message: string;
  readonly goal: string | null | undefined;
}): string | null {
  const goal = input.goal?.trim();
  const message = input.message.trim();
  return goal && (message === THREAD_GOAL_START_MESSAGE || message === THREAD_GOAL_CONTINUE_MESSAGE)
    ? goal
    : null;
}

/** Whether Run goal can start a turn now. There is no queue: Run is offered on an idle thread. */
export type ThreadGoalRunState = "no-goal" | "paused" | "working" | "blocked" | "ready";

export function threadGoalRunState(input: {
  readonly goal: Pick<ThreadGoal, "pausedAt"> | null;
  readonly working: boolean;
  readonly canSend: boolean;
}): ThreadGoalRunState {
  if (input.goal === null) return "no-goal";
  if (input.goal.pausedAt !== null) return "paused";
  if (input.working) return "working";
  return input.canSend ? "ready" : "blocked";
}
