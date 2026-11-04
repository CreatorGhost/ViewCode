import {
  CommandCodeSettings,
  DevinSettings,
  DroidSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

export const viewCodeProviderClients = [
  defineProviderClient({
    driverKind: ProviderDriverKind.make("commandCode"),
    label: "Command Code",
    settingsSchema: CommandCodeSettings,
    badgeLabel: "Early Access",
  }),
  defineProviderClient({
    driverKind: ProviderDriverKind.make("droid"),
    label: "Droid",
    settingsSchema: DroidSettings,
    environmentFields: [{ name: "FACTORY_API_KEY", label: "Factory API key", sensitive: true }],
  }),
  defineProviderClient({
    driverKind: ProviderDriverKind.make("devin"),
    label: "Devin",
    settingsSchema: DevinSettings,
    environmentFields: [{ name: "WINDSURF_API_KEY", label: "Windsurf API key", sensitive: true }],
  }),
];
