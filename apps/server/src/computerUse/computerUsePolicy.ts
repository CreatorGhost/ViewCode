/**
 * Pure policy pieces of computer use: request shape checks, the app denylist,
 * the destructive-target heuristic, approval wording and driver error mapping.
 * `ComputerUseService` applies them; nothing here touches the driver.
 *
 * The denylist and the destructive heuristic are name matching, not a
 * detector. They exist so an agent cannot quietly drive a password manager or
 * ViewCode's own approval buttons, and so obviously risky clicks always reach
 * the user, but a renamed control or an unknown app is not caught.
 */
import {
  COMPUTER_USE_INPUT_COMMANDS,
  ComputerUseRequest,
  type ComputerUseCommand,
  type ComputerUseEffect,
  type ComputerUseError,
  type ComputerUseErrorCode,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ComputerDriverError, DriverWindow } from "./ComputerDriver.ts";

export const COMPUTER_USE_ROUTE_PATH = "/api/computer-use";

export type ComputerUseInputCommand = (typeof COMPUTER_USE_INPUT_COMMANDS)[number];
export type ComputerUseInputRequest = Extract<
  ComputerUseRequest,
  { command: ComputerUseInputCommand }
>;

const inputCommands: ReadonlySet<string> = new Set(COMPUTER_USE_INPUT_COMMANDS);

export const isInputRequest = (request: ComputerUseRequest): request is ComputerUseInputRequest =>
  inputCommands.has(request.command);

export const computerUseError = (
  code: ComputerUseErrorCode,
  message: string,
  effect?: ComputerUseEffect,
): ComputerUseError => ({ code, message, ...(effect ? { effect } : {}) });

/** Arguments each command takes besides `command`. Kept beside the contract union. */
const COMMAND_ARGUMENTS = {
  status: { required: [], optional: [] },
  "list-windows": { required: [], optional: ["app"] },
  observe: { required: ["window"], optional: ["query"] },
  screenshot: { required: ["window"], optional: ["maxSize"] },
  press: { required: ["ref"], optional: [] },
  "set-value": { required: ["ref", "value"], optional: [] },
  type: { required: ["ref", "text"], optional: [] },
  key: { required: ["window", "keys"], optional: [] },
  scroll: { required: ["ref", "dx", "dy"], optional: [] },
  click: { required: ["shot", "x", "y"], optional: ["button", "count"] },
  drag: { required: ["shot", "fromX", "fromY", "toX", "toY"], optional: [] },
  move: { required: ["shot", "x", "y"], optional: [] },
  "scroll-at": { required: ["shot", "x", "y", "dx", "dy"], optional: [] },
  "type-focused": { required: ["window", "text"], optional: [] },
} as const satisfies Record<
  ComputerUseCommand,
  { readonly required: ReadonlyArray<string>; readonly optional: ReadonlyArray<string> }
>;

const isCommand = (value: unknown): value is ComputerUseCommand =>
  Predicate.isString(value) && Object.hasOwn(COMMAND_ARGUMENTS, value);

const memberFields = (command: ComputerUseCommand): Readonly<Record<string, Schema.Top>> => {
  for (const member of ComputerUseRequest.members) {
    if (member.fields.command.literal === command) return member.fields;
  }
  return {};
};

const decodeRequest = Schema.decodeUnknownExit(ComputerUseRequest, {
  onExcessProperty: "error",
});

/**
 * Validates an untrusted request body. Messages name arguments, never their
 * values: a rejected `type` request must not echo the text back into logs.
 */
export function validateComputerUseRequest(
  body: unknown,
):
  | { readonly ok: true; readonly request: ComputerUseRequest }
  | { readonly ok: false; readonly error: ComputerUseError } {
  if (!Predicate.isObject(body) || Array.isArray(body)) {
    return {
      ok: false,
      error: computerUseError("CU-VAL-001", "The request must be a JSON object with a command."),
    };
  }
  const command = body.command;
  if (!isCommand(command)) {
    return {
      ok: false,
      error: computerUseError(
        "CU-VAL-001",
        `Unknown command. Run \`viewcode-computer help\` for the list of commands.`,
      ),
    };
  }
  const spec: {
    readonly required: ReadonlyArray<string>;
    readonly optional: ReadonlyArray<string>;
  } = COMMAND_ARGUMENTS[command];
  const unexpected = Object.keys(body).filter(
    (key) => key !== "command" && !spec.required.includes(key) && !spec.optional.includes(key),
  );
  if (unexpected.length > 0) {
    return {
      ok: false,
      error: computerUseError(
        "CU-VAL-004",
        `\`${command}\` does not accept: ${unexpected.map(clipName).join(", ")}.`,
      ),
    };
  }
  const missing = spec.required.filter((key) => body[key] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      error: computerUseError("CU-VAL-002", `\`${command}\` requires: ${missing.join(", ")}.`),
    };
  }
  const decoded = decodeRequest(body);
  if (Exit.isSuccess(decoded)) return { ok: true, request: decoded.value };
  const fields = memberFields(command);
  const invalid = [...spec.required, ...spec.optional].filter((key) => {
    const field = fields[key];
    return body[key] !== undefined && field !== undefined && !Schema.is(field)(body[key]);
  });
  return {
    ok: false,
    error: computerUseError(
      "CU-VAL-003",
      invalid.length > 0
        ? `\`${command}\` has an invalid ${invalid.join(", ")}. Run \`viewcode-computer help\` for the accepted values.`
        : `\`${command}\` has an invalid argument.`,
    ),
  };
}

const clipName = (name: string) => (name.length > 40 ? `${name.slice(0, 40)}…` : name);

// ── Denylist ────────────────────────────────────────────────────────────────

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();

/** Normalized app names (as `normalize` leaves them). */
const DENYLISTED_APP_NAMES: ReadonlySet<string> = new Set([
  "1password",
  "1password 7",
  "1password 8",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keeper",
  "keeper password manager",
  "passwords",
  "keychain access",
  "system settings",
  "system preferences",
  "securityagent",
  "loginwindow",
  "viewcode",
  "t3 code",
  "t3code",
  "t3 code alpha",
  "t3 code dev",
  "viewcode dev",
]);

/** Executable file names (normalized, without extension) that mark a denylisted app. */
const DENYLISTED_EXECUTABLES: ReadonlySet<string> = new Set([
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keeper",
  "keeperpasswordmanager",
  "viewcode",
  "t3code",
  "t3 code",
  "securityagent",
  "loginwindow",
]);

/**
 * Whether ViewCode refuses every command but `list-windows` on this window's
 * app. ViewCode itself is on the list so an agent can never click its own
 * approval buttons.
 *
 * `appIdentifier` is the executable path the driver reports (no bundle ids):
 * any `<Name>.app` bundle on that path counts as the app's name, so a helper
 * inside `ViewCode.app` or `1Password.app` is caught too, as is a renamed
 * window title.
 */
export function isDenylistedApp(window: Pick<DriverWindow, "app" | "appIdentifier">): boolean {
  if (DENYLISTED_APP_NAMES.has(normalize(window.app))) return true;
  const identifier = window.appIdentifier?.trim();
  if (!identifier) return false;
  const segments = identifier.split(/[\\/]/).filter((segment) => segment.length > 0);
  const bundles = segments.filter((segment) => /\.app$/i.test(segment));
  if (bundles.some((bundle) => DENYLISTED_APP_NAMES.has(normalize(bundle.slice(0, -4))))) {
    return true;
  }
  const executable = segments.at(-1)?.replace(/\.(exe|appimage)$/i, "");
  return executable !== undefined && DENYLISTED_EXECUTABLES.has(normalize(executable));
}

// ── Destructive heuristic ───────────────────────────────────────────────────

const DESTRUCTIVE_WORDS =
  /\b(delete|remove|erase|discard|uninstall|purchase|buy|pay|checkout|check out|place order|transfer|send|submit|sign out|signout|log out|logout|reset|format)\b/;

/** A label or role that looks like it commits, pays, sends or destroys something. */
export function isDestructiveTarget(target: { readonly role: string; readonly label: string }) {
  return DESTRUCTIVE_WORDS.test(`${target.label} ${target.role}`.toLowerCase());
}

/** Quit, close and delete chords: cmd/ctrl+q|w, alt+f4, cmd/ctrl+delete|backspace. */
export function isDestructiveChord(keys: string): boolean {
  const parts = keys.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const modifiers = new Set(parts.slice(0, -1));
  const command =
    modifiers.has("cmd") ||
    modifiers.has("ctrl") ||
    modifiers.has("meta") ||
    modifiers.has("super");
  const alt = modifiers.has("alt") || modifiers.has("option");
  if (command && (key === "q" || key === "w" || key === "delete" || key === "backspace"))
    return true;
  return alt && key === "f4";
}

// ── Approval wording ────────────────────────────────────────────────────────

const singleLine = (value: string, max: number) => {
  const line = value.replaceAll(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const quoted = (value: string, max = 60) => {
  const line = singleLine(value, max);
  return line.length > 0 ? `"${line}"` : "(no label)";
};

export interface ApprovalTarget {
  readonly app: string;
  readonly windowTitle: string;
  /** The ref's element for ref commands. */
  readonly element?: { readonly role: string; readonly label: string };
  /**
   * For coordinate commands: what the point hits, `null` when nothing
   * labelled is there (or the app exposes no tree).
   */
  readonly hit?: { readonly role: string; readonly label: string } | null;
}

const describeElement = (element: { readonly role: string; readonly label: string }) =>
  `${singleLine(element.role, 30) || "element"} ${quoted(element.label)}`;

/**
 * One line for the approval card: action, element role and label, app and
 * window title. Typed and set text appears only as a character count.
 * Coordinate commands give image pixels and say the window comes to the front.
 */
export function describeInputForApproval(
  request: ComputerUseInputRequest,
  target: ApprovalTarget,
): string {
  const element = target.element ? describeElement(target.element) : "";
  const where = `in ${singleLine(target.app, 40) || "an app"} — ${quoted(target.windowTitle)}`;
  const hit =
    target.hit === undefined
      ? ""
      : target.hit === null
        ? " (no labelled control there)"
        : ` (on ${describeElement(target.hit)})`;
  const front = "; brings the window to the front";
  switch (request.command) {
    case "press":
      return `Press ${element} ${where}`;
    case "set-value":
      return `Set ${element} to ${characterCount(request.value)} ${where}`;
    case "type":
      return `Type ${characterCount(request.text)} into ${element} ${where}`;
    case "key":
      return `Press ${request.keys} ${where}`;
    case "scroll":
      return `Scroll ${element} by (${request.dx}, ${request.dy}) ${where}`;
    case "click": {
      const count = request.count ?? 1;
      const button = request.button ?? "left";
      const verb =
        button === "right"
          ? "Right-click"
          : button === "middle"
            ? "Middle-click"
            : count === 2
              ? "Double-click"
              : count === 3
                ? "Triple-click"
                : "Click";
      return `${verb} at (${request.x}, ${request.y}) ${where}${hit}${front}`;
    }
    case "drag":
      return `Drag from (${request.fromX}, ${request.fromY}) to (${request.toX}, ${request.toY}) ${where}${hit}${front}`;
    case "move":
      return `Move the pointer to (${request.x}, ${request.y}) ${where}${hit}${front}`;
    case "scroll-at":
      return `Scroll by (${request.dx}, ${request.dy}) at (${request.x}, ${request.y}) ${where}${hit}${front}`;
    case "type-focused":
      return `Type ${characterCount(request.text)} into the focused field ${where}${front}`;
  }
}

const characterCount = (text: string) => {
  const count = [...text].length;
  return `${count} character${count === 1 ? "" : "s"}`;
};

// ── Driver errors ───────────────────────────────────────────────────────────

const effectOf = (dispatched: ComputerDriverError["dispatched"]): ComputerUseEffect =>
  dispatched === "no"
    ? "not-dispatched"
    : dispatched === "unknown"
      ? "dispatched-unknown"
      : "dispatched";

/** Maps a driver failure; input commands carry what the OS may have received. */
export function driverErrorToComputerUseError(
  error: ComputerDriverError,
  options: { readonly input: boolean },
): ComputerUseError {
  const effect = options.input ? effectOf(error.dispatched) : undefined;
  switch (error.kind) {
    case "unavailable":
      return computerUseError("CU-EXT-001", error.message, effect);
    case "permission-accessibility":
      return computerUseError("CU-EXT-002", error.message, effect);
    case "permission-screen":
      return computerUseError("CU-EXT-003", error.message, effect);
    case "stale":
      return computerUseError(
        "CU-CON-003",
        "The element changed since it was observed; observe the window again.",
        effect,
      );
    case "malformed":
      return computerUseError("CU-EXT-005", error.message, effect);
    case "failed":
    case "timeout":
      return computerUseError(
        "CU-EXT-004",
        effect === "dispatched-unknown"
          ? `${error.message} The input may have been delivered; observe before retrying.`
          : error.message,
        effect,
      );
  }
}
