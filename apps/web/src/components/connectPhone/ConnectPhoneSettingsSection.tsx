import { SmartphoneIcon } from "lucide-react";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { openConnectPhoneDialog } from "./ConnectPhoneDialog";

/** Top of Settings → Connections: the one-step way to pair the mobile app. */
export function ConnectPhoneSettingsSection() {
  return (
    <SettingsSection
      title="Phone"
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
      id="connect-phone"
    >
      <SettingsRow
        title="Connect phone"
        description="Scan a code with the T3 Code mobile app. No account needed."
        control={
          <Button size="sm" onClick={openConnectPhoneDialog}>
            Connect phone
          </Button>
        }
      />
    </SettingsSection>
  );
}
