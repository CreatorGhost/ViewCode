import {
  DEFAULT_SERVER_SETTINGS,
  type ComputerUseActivityEntry,
  type ComputerUseApprovals,
  type ComputerUseMode,
  type ComputerUseStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  COMPUTER_USE_ACTIVITY_EMPTY,
  COMPUTER_USE_APPROVALS,
  COMPUTER_USE_APPROVALS_LABELS,
  COMPUTER_USE_DESCRIPTION,
  COMPUTER_USE_GETTING_STARTED_STEPS,
  COMPUTER_USE_MODES,
  COMPUTER_USE_MODE_LABELS,
  describeComputerUseApprovals,
  describeComputerUseStatus,
  showsComputerUseApprovals,
} from "./ComputerUseSetting.logic";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly status: ComputerUseStatus }
  | { readonly phase: "error"; readonly message: string };

const SETTING_KEYS = ["computerUse"] as const;
const APPROVALS_SETTING_KEYS = ["computerUseApprovals"] as const;

/**
 * What the selected environment's machine can do right now, fetched when this
 * mounts (the caller remounts it when the mode or environment changes), and
 * on "Check again". It is a
 * command rather than a cached query: Accessibility can be granted or revoked
 * at any moment, and the answer is about the server's machine, not the
 * browser's.
 */
function ComputerUseStatusLine({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const getStatus = useAtomCommand(serverEnvironment.getComputerUseStatus, {
    reportFailure: false,
  });
  const [state, setState] = useState<StatusState>({ phase: "loading" });
  // Only the latest request may write state; a slow earlier answer is stale.
  const latestRequest = useRef(0);

  const fetchStatus = useCallback(async () => {
    const request = ++latestRequest.current;
    const result = await getStatus({ environmentId, input: {} });
    if (request !== latestRequest.current) return;
    if (result._tag === "Success") {
      setState({ phase: "ready", status: result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setState({
      phase: "error",
      message:
        cause instanceof Error && cause.message
          ? cause.message
          : "Couldn't check computer use on this machine.",
    });
  }, [environmentId, getStatus]);

  useEffect(() => {
    void fetchStatus();
    return () => {
      latestRequest.current++;
    };
  }, [fetchStatus]);

  const check = () => {
    setState({ phase: "loading" });
    void fetchStatus();
  };

  const line =
    state.phase === "ready"
      ? describeComputerUseStatus(state.status)
      : state.phase === "error"
        ? { ready: false, message: state.message }
        : null;
  const Icon = line?.ready ? CheckIcon : CircleAlertIcon;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {line ? (
        <span className="flex items-center gap-1.5">
          <Icon
            aria-hidden
            className={line.ready ? "size-3.5 text-success" : "size-3.5 text-muted-foreground"}
          />
          {line.message}
        </span>
      ) : (
        <span>Checking…</span>
      )}
      <Button size="xs" variant="outline" disabled={state.phase === "loading"} onClick={check}>
        Check again
      </Button>
    </div>
  );
}

type ActivityState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly entries: ReadonlyArray<ComputerUseActivityEntry> }
  | { readonly phase: "error"; readonly message: string };

function ComputerUseActivityRow({
  environmentId,
  entry,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: ComputerUseActivityEntry;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, entry.threadId),
    [environmentId, entry.threadId],
  );
  const title = useThreadShell(threadRef)?.title;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
      <span className="w-16 shrink-0 text-muted-foreground">
        {formatRelativeTimeLabel(entry.at)}
      </span>
      <span className="font-mono text-foreground">{entry.command}</span>
      <span className={entry.outcome === "ok" ? "text-muted-foreground" : "font-mono"}>
        {entry.outcome}
      </span>
      {entry.tookFocus ? <span className="text-muted-foreground">took focus</span> : null}
      {title ? <span className="min-w-0 truncate text-muted-foreground">{title}</span> : null}
    </li>
  );
}

/**
 * The last computer use requests the selected environment handled. Fetched
 * when this mounts (the disclosure opens) and on "Refresh"; never polled.
 * Entries name the command and outcome only, so there is nothing typed or
 * targeted to show.
 */
function ComputerUseActivityList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const getActivity = useAtomCommand(serverEnvironment.getComputerUseActivity, {
    reportFailure: false,
  });
  const [state, setState] = useState<ActivityState>({ phase: "loading" });
  const latestRequest = useRef(0);

  const fetchActivity = useCallback(async () => {
    const request = ++latestRequest.current;
    const result = await getActivity({ environmentId, input: {} });
    if (request !== latestRequest.current) return;
    if (result._tag === "Success") {
      setState({ phase: "ready", entries: result.value.entries });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setState({
      phase: "error",
      message:
        cause instanceof Error && cause.message
          ? cause.message
          : "Couldn't load recent computer actions.",
    });
  }, [environmentId, getActivity]);

  useEffect(() => {
    void fetchActivity();
    return () => {
      latestRequest.current++;
    };
  }, [fetchActivity]);

  const refresh = () => {
    setState({ phase: "loading" });
    void fetchActivity();
  };

  return (
    <div className="space-y-1 pb-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          Newest first. Typed text and targets are never recorded.
        </span>
        <Button size="xs" variant="outline" disabled={state.phase === "loading"} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {state.phase === "loading" ? (
        <p className="py-1.5 text-muted-foreground">Loading…</p>
      ) : state.phase === "error" ? (
        <p className="py-1.5 text-muted-foreground">{state.message}</p>
      ) : state.entries.length === 0 ? (
        <p className="py-1.5 text-muted-foreground">{COMPUTER_USE_ACTIVITY_EMPTY}</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {state.entries.map((entry, index) => (
            <ComputerUseActivityRow
              // Entries have no id, and the list is replaced whole on refresh.
              // oxlint-disable-next-line react/no-array-index-key
              key={`${entry.at}:${index}`}
              environmentId={environmentId}
              entry={entry}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A settings row whose body stays out of the page, and out of the network, until opened. */
function ComputerUseDisclosure({
  searchId,
  children,
}: {
  readonly searchId: "computer-use-activity" | "computer-use-getting-started";
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      control={
        <Button size="xs" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open ? children : null}
    </SettingsRow>
  );
}

function ComputerUseApprovalsSetting() {
  const approvals = useScopedSettings((settings) => settings.computerUseApprovals);
  const mixed = useScopedSettingsMixed(APPROVALS_SETTING_KEYS);
  const updateSettings = useUpdateScopedSettings();
  const defaultApprovals = DEFAULT_SERVER_SETTINGS.computerUseApprovals;

  return (
    <SettingsRow
      {...searchableSetting("computer-use-approvals")}
      serverScoped
      settingKeys={APPROVALS_SETTING_KEYS}
      mixed={mixed}
      description={describeComputerUseApprovals(approvals)}
      resetAction={
        approvals !== defaultApprovals || mixed ? (
          <SettingResetButton
            label="ask before computer input"
            onClick={() => updateSettings({ computerUseApprovals: defaultApprovals })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : approvals}
          onValueChange={(value) => {
            const next = COMPUTER_USE_APPROVALS.find((candidate) => candidate === value);
            if (next) updateSettings({ computerUseApprovals: next });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-48"
            aria-label="Ask before computer input"
          >
            <SelectValue>
              {(value: string | null) =>
                COMPUTER_USE_APPROVALS.find((candidate) => candidate === value)
                  ? COMPUTER_USE_APPROVALS_LABELS[value as ComputerUseApprovals]
                  : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {COMPUTER_USE_APPROVALS.map((candidate) => (
              <SelectItem hideIndicator key={candidate} value={candidate}>
                {COMPUTER_USE_APPROVALS_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ComputerUseSetting() {
  const { environment } = useSettingsScope();
  const mode = useScopedSettings((settings) => settings.computerUse);
  const mixed = useScopedSettingsMixed(SETTING_KEYS);
  const updateSettings = useUpdateScopedSettings();
  const defaultMode = DEFAULT_SERVER_SETTINGS.computerUse;

  return (
    <>
      <SettingsRow
        {...searchableSetting("computer-use")}
        serverScoped
        settingKeys={SETTING_KEYS}
        mixed={mixed}
        description={COMPUTER_USE_DESCRIPTION}
        resetAction={
          mode !== defaultMode || mixed ? (
            <SettingResetButton
              label="computer use"
              onClick={() => updateSettings({ computerUse: defaultMode })}
            />
          ) : null
        }
        status={
          mode !== "off" && environment ? (
            <ComputerUseStatusLine
              key={`${environment.environmentId}:${mode}`}
              environmentId={environment.environmentId}
            />
          ) : null
        }
        control={
          <Select
            value={mixed ? null : mode}
            onValueChange={(value) => {
              const next = COMPUTER_USE_MODES.find((candidate) => candidate === value);
              if (next) updateSettings({ computerUse: next });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Computer use">
              <SelectValue>
                {(value: string | null) =>
                  COMPUTER_USE_MODES.find((candidate) => candidate === value)
                    ? COMPUTER_USE_MODE_LABELS[value as ComputerUseMode]
                    : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {COMPUTER_USE_MODES.map((candidate) => (
                <SelectItem hideIndicator key={candidate} value={candidate}>
                  {COMPUTER_USE_MODE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {showsComputerUseApprovals(mode) ? <ComputerUseApprovalsSetting /> : null}
      {environment ? (
        <ComputerUseDisclosure searchId="computer-use-activity">
          <ComputerUseActivityList
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        </ComputerUseDisclosure>
      ) : null}
      <ComputerUseDisclosure searchId="computer-use-getting-started">
        <ol className="list-decimal space-y-1.5 pb-2 ps-4 text-xs text-muted-foreground">
          {COMPUTER_USE_GETTING_STARTED_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </ComputerUseDisclosure>
    </>
  );
}
