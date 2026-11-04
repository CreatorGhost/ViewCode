import { expect, it } from "vite-plus/test";

import { PREVIEW_WEBVIEW_PREFERENCES } from "./WebviewPreferences.ts";

// ViewCode guard: without this key a page looping `alert(); location.reload()` locks the window
// with no way to close its tab, because nothing else in the app answers a page's native dialog.
it("lets the user stop a page's repeated dialogs (ViewCode)", () => {
  expect(PREVIEW_WEBVIEW_PREFERENCES.split(",")).toContain("safeDialogs=true");
});
