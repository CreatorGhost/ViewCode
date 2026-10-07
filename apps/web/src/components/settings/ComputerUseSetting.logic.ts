import type {
  ComputerUseApprovals,
  ComputerUseMode,
  ComputerUseScreen,
  ComputerUseStatus,
} from "@t3tools/contracts";

export const COMPUTER_USE_MODES: ReadonlyArray<ComputerUseMode> = ["off", "observe", "control"];

export const COMPUTER_USE_MODE_LABELS: Readonly<Record<ComputerUseMode, string>> = {
  off: "Off",
  observe: "Observe only",
  control: "Observe and control",
};

export const COMPUTER_USE_DESCRIPTION =
  "Let agents see, and with control operate, apps on this machine through ViewCode. With control, you choose when input asks first. Password managers, System Settings and ViewCode itself are never controlled. A change applies to each thread from its next message.";

export const COMPUTER_USE_APPROVALS: ReadonlyArray<ComputerUseApprovals> = [
  "thread",
  "risky",
  "never",
];

export const COMPUTER_USE_APPROVALS_LABELS: Readonly<Record<ComputerUseApprovals, string>> = {
  thread: "Follow thread permissions",
  risky: "Only for risky actions",
  never: "Never",
};

const COMPUTER_USE_APPROVALS_DESCRIPTION =
  "When agents ask before clicking or typing. Blocked apps stay blocked, and input pauses while any approval waits.";

export const COMPUTER_USE_SCREENS: ReadonlyArray<ComputerUseScreen> = ["allow", "ask"];

export const COMPUTER_USE_SCREEN_LABELS: Readonly<Record<ComputerUseScreen, string>> = {
  allow: "Whenever needed",
  ask: "Ask once per task",
};

export const COMPUTER_USE_SCREEN_DESCRIPTION =
  "Whether agents may bring windows to the front for clicks and typing. Ask once per task lets you keep a task in the background, where agents act on controls directly.";

/** Only control mode sends input, so only it has approvals to configure. */
export function showsComputerUseApprovals(mode: ComputerUseMode): boolean {
  return mode === "control";
}

/** The approvals row description; `never` adds the caution that agents stop asking. */
export function describeComputerUseApprovals(approvals: ComputerUseApprovals): string {
  return approvals === "never"
    ? `${COMPUTER_USE_APPROVALS_DESCRIPTION} Agents act without asking.`
    : COMPUTER_USE_APPROVALS_DESCRIPTION;
}

const MACOS_ACCESSIBILITY_GUIDANCE =
  "Grant Accessibility to ViewCode in System Settings → Privacy & Security → Accessibility, then check again.";

/**
 * The status line for what the server's machine can do right now. The server
 * words `reason` for the user, so it wins over the generic fallbacks except
 * where the fix is known and specific.
 */
export function describeComputerUseStatus(status: ComputerUseStatus): {
  readonly ready: boolean;
  readonly message: string;
} {
  if (!status.driverAvailable) {
    return {
      ready: false,
      message:
        status.reason ??
        `Computer use isn't available on this machine's platform (${status.platform}).`,
    };
  }
  switch (status.accessibility) {
    case "granted":
      return {
        ready: true,
        message: "Accessibility granted. Screenshots also need Screen Recording.",
      };
    case "denied":
      return {
        ready: false,
        message:
          status.platform === "darwin"
            ? MACOS_ACCESSIBILITY_GUIDANCE
            : (status.reason ?? "Accessibility access is denied for ViewCode on this machine."),
      };
    case "unknown":
      return {
        ready: false,
        message: status.reason ?? "Couldn't confirm Accessibility access. Check again in a moment.",
      };
  }
}

export const COMPUTER_USE_GETTING_STARTED_STEPS: ReadonlyArray<string> = [
  "Choose Observe only to let agents look at your apps, or Observe and control to let them operate them too.",
  "On macOS, grant ViewCode Accessibility, and Screen Recording for screenshots, in System Settings → Privacy & Security. Use Check again afterwards.",
  "Ask an agent in any thread, for example: “Use computer use to open Safari and search for …”.",
];

export const COMPUTER_USE_ACTIVITY_EMPTY = "No computer actions yet.";
