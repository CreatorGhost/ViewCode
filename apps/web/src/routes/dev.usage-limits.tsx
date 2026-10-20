import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { UsageLimitsPooled } from "~/components/usage/UsageLimitsPooled";

/**
 * Development preview of the Usage page's Limits view: sample accounts run through the same
 * pooling the page uses, including a two-account pool and banked reset credits. Not in
 * production builds.
 */
export const Route = createFileRoute("/dev/usage-limits")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: UsageLimitsPreview,
});

const NOW = Date.now();
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const limitWindow = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  resetsInHours: number,
  windowDurationMins: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  resetsAt: inHours(resetsInHours),
  windowDurationMins,
});

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  email: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  resetCredits?: number,
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: new Date(NOW).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows,
      ...(resetCredits === undefined ? {} : { resetCredits: { availableCount: resetCredits } }),
    },
  }) satisfies ServerProvider;

const presentations: LimitPresentations = new Map([
  [
    EnvironmentId.make("env-local"),
    {
      entry: { target: { label: "This Mac" } },
      serverConfig: {
        usageLimitSources: [],
        providers: [
          provider(
            "codex-work",
            "codex",
            "Codex",
            "work@example.com",
            [
              limitWindow("five_hour", "session", "Session", 62, 3.3, 300),
              limitWindow("weekly", "weekly", "Weekly", 17, 6 * 24 + 8, 7 * 24 * 60),
            ],
            1,
          ),
          provider("codex-home", "codex", "Codex", "home@example.com", [
            limitWindow("five_hour", "session", "Session", 88, 1.2, 300),
            limitWindow("weekly", "weekly", "Weekly", 41, 6 * 24 + 8, 7 * 24 * 60),
          ]),
          provider("claude", "claudeAgent", "Claude", "me@example.com", [
            limitWindow("five_hour", "session", "Session", 45, 3.3, 300),
            limitWindow("seven_day", "weekly", "Weekly", 30, 6 * 24 + 12, 7 * 24 * 60),
            limitWindow(
              "seven_day_fable",
              "weekly",
              "Weekly · Fable",
              22,
              6 * 24 + 12,
              7 * 24 * 60,
            ),
          ]),
          provider("grok", "grok", "Grok", "me@example.com", [
            limitWindow("weekly", "weekly", "Weekly", 9, 17.1, 7 * 24 * 60),
          ]),
          provider("antigravity", "antigravity", "Antigravity", "me@example.com", [
            limitWindow("gemini-5h", "session", "5-hour", 0, 2, 300),
            limitWindow("gemini-weekly", "weekly", "Weekly", 0, 5 * 24, 7 * 24 * 60),
          ]),
        ],
      },
    },
  ],
]);

function UsageLimitsPreview() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <UsageLimitsPooled presentations={presentations} now={NOW} />
    </div>
  );
}
