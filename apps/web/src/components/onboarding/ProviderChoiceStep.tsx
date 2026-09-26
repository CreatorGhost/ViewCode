import { EnvironmentId, type DetectedProvider, type ProviderDriverKind } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  buildProviderChoiceTiles,
  enableAgentsButtonLabel,
  orderedChosenDrivers,
  providerChoiceDetectionLabel,
  providerSelectionView,
  type ProviderChoiceTile,
  type ProviderSelectionView,
} from "../../onboarding/providerChoice.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type DetectState =
  | { readonly status: "loading"; readonly providers: ReadonlyArray<DetectedProvider> | null }
  | { readonly status: "ready"; readonly providers: ReadonlyArray<DetectedProvider> }
  | { readonly status: "error"; readonly providers: ReadonlyArray<DetectedProvider> | null };

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function providerChoiceDisplayName(driver: ProviderDriverKind): string {
  if (driver === "claudeAgent") return "Claude Code";
  return getDriverOption(driver)?.label ?? driver;
}

const ENVIRONMENT_ID_SEPARATOR = "\u0000";

// Keyed on the joined ids so every render with the same ids shares one atom.
const providerSelectionViewsAtom = Atom.family((joinedIds: string) =>
  Atom.make((get): readonly ProviderSelectionView[] =>
    joinedIds
      .split(ENVIRONMENT_ID_SEPARATOR)
      .filter((id) => id.length > 0)
      .map((id) =>
        providerSelectionView(
          get(serverEnvironment.configValueAtom(EnvironmentId.make(id)))?.settings,
        ),
      ),
  ),
);

/** Each environment's provider selection, in the order given. */
export function useProviderSelectionViews(
  environmentIds: readonly EnvironmentId[],
): readonly ProviderSelectionView[] {
  return useAtomValue(providerSelectionViewsAtom(environmentIds.join(ENVIRONMENT_ID_SEPARATOR)));
}

/**
 * First-run agent choice for one environment whose `providerSelection` is
 * pending. Detection only looks on disk, and the choice is what lets the
 * server probe anything, so this must never call `refreshProviders`.
 */
export function ProviderChoiceStep({
  environmentId,
  machineLabel,
  onChosen,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onChosen?: (enabled: readonly ProviderDriverKind[]) => void;
}) {
  const detectProviders = useAtomCommand(serverEnvironment.detectProviders, {
    reportFailure: false,
  });
  const chooseProviders = useAtomCommand(serverEnvironment.chooseProviders, {
    reportFailure: false,
  });
  const [detect, setDetect] = useState<DetectState>({ status: "loading", providers: null });
  const [chosen, setChosen] = useState<ReadonlySet<ProviderDriverKind>>(() => new Set());
  const [submitting, setSubmitting] = useState<"enable" | "none" | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchDetected = useCallback(async () => {
    const result = await detectProviders({ environmentId, input: {} });
    if (!mountedRef.current) return;
    if (result._tag === "Success") {
      setDetect({ status: "ready", providers: result.value.providers });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setDetect((current) => ({ status: "error", providers: current.providers }));
  }, [detectProviders, environmentId]);

  // Initial state is already "loading"; "Check again" sets it before fetching.
  useEffect(() => {
    void fetchDetected();
  }, [fetchDetected]);
  const runDetect = () => {
    setDetect((current) => ({ status: "loading", providers: current.providers }));
    void fetchDetected();
  };

  const tiles = useMemo(() => buildProviderChoiceTiles(detect.providers), [detect.providers]);

  const submit = async (enabled: readonly ProviderDriverKind[]) => {
    if (submitting !== null) return;
    setSubmitting(enabled.length > 0 ? "enable" : "none");
    setChooseError(null);
    const result = await chooseProviders({ environmentId, input: { enabled: [...enabled] } });
    if (!mountedRef.current) return;
    setSubmitting(null);
    if (result._tag === "Success") {
      onChosen?.(enabled);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setChooseError(failureMessage(result, "Couldn't save your choice."));
  };

  const toggle = (driver: ProviderDriverKind, on: boolean) => {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(driver);
      else next.delete(driver);
      return next;
    });
  };

  return (
    <section className="@container">
      <h2 className="text-sm font-medium text-foreground">Agents on {machineLabel}</h2>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        Choose which agents ViewCode may run on this computer. Nothing runs until you choose.
      </p>
      {detect.status === "error" ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>Couldn't look for installed agents.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={runDetect}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-1.5 @md:grid-cols-2">
        {tiles.map((tile) => (
          <ProviderChoiceTileRow
            key={tile.driver}
            tile={tile}
            checked={chosen.has(tile.driver)}
            disabled={submitting !== null}
            onCheckedChange={(on) => toggle(tile.driver, on)}
          />
        ))}
      </div>
      {chooseError ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>{chooseError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={runDetect}
          disabled={detect.status === "loading"}
        >
          <RefreshCwIcon />
          {detect.status === "loading" ? "Checking..." : "Check again"}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void submit([])}
            disabled={submitting !== null}
          >
            {submitting === "none" ? "Saving..." : "Continue without agents"}
          </Button>
          <Button
            size="sm"
            onClick={() => void submit(orderedChosenDrivers(chosen))}
            disabled={chosen.size === 0 || submitting !== null}
          >
            {submitting === "enable" ? "Enabling..." : enableAgentsButtonLabel(chosen.size)}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ProviderChoiceTileRow({
  tile,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly tile: ProviderChoiceTile;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const Icon = getDriverOption(tile.driver)?.icon;
  const name = providerChoiceDisplayName(tile.driver);
  const { detection } = tile;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? (
        <Icon
          className={cn("size-5 shrink-0", tile.driver !== "claudeAgent" && "fill-foreground")}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <p className="mt-0.5 flex min-w-0 gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">{providerChoiceDetectionLabel(detection)}</span>
          {detection.kind === "found" && detection.path !== null ? (
            <Tooltip>
              <TooltipTrigger render={<code className="min-w-0 truncate font-mono select-text" />}>
                {detection.path}
              </TooltipTrigger>
              <TooltipPopup side="top">{detection.path}</TooltipPopup>
            </Tooltip>
          ) : null}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={`Let ViewCode run ${name}`}
      />
    </div>
  );
}
