import { DEFAULT_SERVER_SETTINGS, type RuntimeMode, type ServerSettings } from "@t3tools/contracts";

// The fork's new-chat default differs from upstream; saved selections still win.
export const VIEWCODE_DEFAULT_RUNTIME_MODE = "auto" satisfies RuntimeMode;
export const VIEWCODE_DEFAULT_SERVER_SETTINGS: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultRuntimeMode: VIEWCODE_DEFAULT_RUNTIME_MODE,
};
