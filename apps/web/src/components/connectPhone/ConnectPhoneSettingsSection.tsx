import { SmartphoneIcon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { describeTailscaleBlock, useTailscaleBlock } from "../../state/tailscaleAccess";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { describeQuickConnectStatus, resolveQuickConnectView } from "./connectPhone.logic";
import { openConnectPhoneDialog } from "./ConnectPhoneDialog";
import {
  CloudflareAccountPicker,
  useViewCodeRelaySetupState,
  useViewCodeRelayState,
} from "./QuickConnectPhone";
import { useTailscalePhoneAccess } from "./useTailscalePhoneAccess";

/** Top of Settings → Connections: the one-step way to pair the mobile app. */
export function ConnectPhoneSettingsSection() {
  const tailscale = useTailscalePhoneAccess();
  const quickView = resolveQuickConnectView(useViewCodeRelayState());
  const quickSetup = useViewCodeRelaySetupState();
  const updateSettings = useUpdatePrimarySettings();
  const tailscaleEnabled = usePrimarySettings((settings) => settings.tailscaleEnabled);
  const tailscaleBlock = useTailscaleBlock(usePrimaryEnvironmentId());
  const quickOn =
    quickView.kind !== "off" && quickView.kind !== "not-set-up" && quickView.kind !== "loading";
  return (
    <SettingsSection
      title="Phone"
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
      id="connect-phone"
    >
      <SettingsRow
        title="Connect phone"
        description="Scan a pairing code with the ViewCode phone app. No account needed on the phone."
        control={
          <Button size="sm" onClick={() => openConnectPhoneDialog()}>
            Connect phone
          </Button>
        }
      />
      <SettingsRow
        title="Quick connect"
        description={describeQuickConnectStatus(quickView, quickSetup)}
        control={
          // Setup, redeploy and removal live in the Connect phone dialog's Quick connect tab.
          quickView.kind === "not-set-up" || quickSetup?.status === "running" ? (
            <Button size="sm" variant="outline" onClick={() => openConnectPhoneDialog("quick")}>
              {quickSetup?.status === "running" ? "Show" : "Set up"}
            </Button>
          ) : (
            <Switch
              checked={quickOn}
              disabled={quickView.kind === "loading"}
              onCheckedChange={(checked) =>
                updateSettings({ viewcodeRelay: { enabled: checked === true } })
              }
              aria-label="Quick connect"
            />
          )
        }
      >
        {quickSetup?.status === "needs-account" ? (
          <CloudflareAccountPicker setup={quickSetup} />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Tailscale"
        description={
          tailscaleBlock === "environment"
            ? describeTailscaleBlock(tailscaleBlock)
            : "Lets ViewCode run the Tailscale app for phone access, Tailscale HTTPS and opening files over Tailscale SSH. Turn it off where security software blocks Tailscale."
        }
        control={
          <Switch
            checked={tailscaleBlock === null && tailscaleEnabled}
            disabled={tailscaleBlock === "environment"}
            onCheckedChange={(checked) => updateSettings({ tailscaleEnabled: checked === true })}
            aria-label="Tailscale"
          />
        }
      />
      {tailscale.access?.installed && tailscaleBlock === null ? (
        <SettingsRow
          title="Turn on Tailscale phone access at launch"
          description="Starts Tailscale HTTPS when ViewCode opens so a paired phone can reach this computer over your tailnet. Turning Tailscale HTTPS off also turns this off."
          control={
            <Switch
              checked={tailscale.access.automatic}
              onCheckedChange={(checked) => void tailscale.setAutomatic(checked === true)}
              aria-label="Turn on Tailscale phone access at launch"
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
