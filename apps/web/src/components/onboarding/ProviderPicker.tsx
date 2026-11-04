import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type DetectedProvider,
  type EnvironmentId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import {
  buildProviderPickerRows,
  providerPickerPatch,
  selectedProviderPickerDrivers,
  type ProviderPickerRow,
} from "@t3tools/client-runtime/provider-picker";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

function providerDisplayName(driver: ProviderDriverKind): string {
  return driver === "claudeAgent" ? "Claude Code" : (providerClients.get(driver)?.label ?? driver);
}

/**
 * First-run choice of which providers ViewCode may start. A brand-new install
 * has every provider off; this only looks on disk for their CLIs, so nothing
 * runs until the user ticks a provider and turns it on.
 */
export function ProviderPicker({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const detectProviders = useAtomCommand(serverEnvironment.detectProviders, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [detected, setDetected] = useState<ReadonlyArray<DetectedProvider> | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<ProviderDriverKind>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void detectProviders({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      // A failed lookup still lists every provider, just without marks.
      setDetected(result._tag === "Success" ? result.value.providers : []);
    });
    return () => {
      current = false;
    };
  }, [detectProviders, environmentId]);

  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const blockedDrivers = config?.adminBlockedProviderDrivers ?? [];
  const rows = buildProviderPickerRows(detected, blockedDrivers);
  const selected = selectedProviderPickerDrivers(rows, picked);

  const toggle = (driver: ProviderDriverKind, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(driver);
      else next.delete(driver);
      return next;
    });

  const turnOn = async () => {
    if (
      !config ||
      selected.size === 0 ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    )
      return;
    setSaving(true);
    setError(null);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: providerPickerPatch(selected, config.settings.providerInstances, blockedDrivers),
      },
    });
    setSaving(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setError(
      cause instanceof Error && cause.message ? cause.message : "Couldn't save your choice.",
    );
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground">Which AI tools do you use?</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        ViewCode will start the tools you pick. If your company blocks one, leave it off.
      </p>
      <div className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <ProviderPickerRowView
            key={row.driver}
            row={row}
            checked={!row.blockedByAdmin && picked.has(row.driver)}
            disabled={saving || !canManage || config === null || row.blockedByAdmin === true}
            onCheckedChange={(on) => toggle(row.driver, on)}
          />
        ))}
      </div>
      {!canManage ? (
        <p className="mt-3 text-xs text-muted-foreground">
          This connection cannot change providers.
        </p>
      ) : null}
      {error ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={() => void turnOn()}
          disabled={selected.size === 0 || saving || !canManage || config === null}
        >
          {saving
            ? "Turning on..."
            : selected.size === 1
              ? "Turn on 1 tool"
              : `Turn on ${selected.size} tools`}
        </Button>
      </div>
    </div>
  );
}

function ProviderPickerRowView({
  row,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly row: ProviderPickerRow;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const name = providerDisplayName(row.driver);
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={`Let ViewCode start ${name}`}
      />
      <ProviderInstanceIcon
        driverKind={row.driver}
        displayName={name}
        className="size-4.5 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
      <span
        className={cn(
          "shrink-0 text-xs",
          row.found ? "text-success-foreground" : "text-muted-foreground",
        )}
      >
        {row.blockedByAdmin
          ? "Blocked by your organization"
          : row.found === null
            ? "Checking..."
            : row.found
              ? "Found on this computer"
              : "Not found"}
      </span>
    </label>
  );
}
