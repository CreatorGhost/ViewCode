import { SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { describeQuickConnectStatus, resolveQuickConnectView } from "./connectPhone.logic";
import { openConnectPhoneDialog } from "./ConnectPhoneDialog";
import { useViewCodeRelayState } from "./QuickConnectPhone";
import { useTailscalePhoneAccess } from "./useTailscalePhoneAccess";

/** Top of Settings → Connections: the one-step way to pair the mobile app. */
export function ConnectPhoneSettingsSection() {
  const tailscale = useTailscalePhoneAccess();
  const cloudConfigured = hasCloudPublicConfig();
  const quickView = resolveQuickConnectView(useViewCodeRelayState());
  const updateSettings = useUpdatePrimarySettings();
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
        description={
          cloudConfigured
            ? "Scan a code with the T3 Code mobile app. No account needed on the phone."
            : "Scan a code with the T3 Code mobile app. T3 Connect (anywhere) is off: add the values in docs/operations/connect-setup.md and rebuild."
        }
        control={
          <Button size="sm" onClick={openConnectPhoneDialog}>
            Connect phone
          </Button>
        }
      />
      <SettingsRow
        title="Quick connect"
        description={describeQuickConnectStatus(quickView)}
        control={
          <Switch
            checked={quickOn}
            disabled={quickView.kind === "not-set-up" || quickView.kind === "loading"}
            onCheckedChange={(checked) =>
              updateSettings({ viewcodeRelay: { enabled: checked === true } })
            }
            aria-label="Quick connect"
          />
        }
      />
      {tailscale.access?.installed ? (
        <SettingsRow
          title="Turn on Tailscale phone access at launch"
          description="Off by default. Starts Tailscale HTTPS when ViewCode opens so the phone can reach this computer over your tailnet. Some security software stops Tailscale, so leave it off on managed computers."
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
