import {
  DEFAULT_SERVER_SETTINGS,
  type ComputerUseApprovals,
  type ComputerUseMode,
  type ComputerUseStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  COMPUTER_USE_APPROVALS,
  COMPUTER_USE_APPROVALS_LABELS,
  COMPUTER_USE_DESCRIPTION,
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
    </>
  );
}
