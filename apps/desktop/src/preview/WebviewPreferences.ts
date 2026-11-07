/**
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Critical
 *   when paired with `contextIsolation=false` — without sandbox, the preload
 *   has full Node access (`require`, `fs`, `child_process`, ...) and that
 *   `require` would land on the page's shared `globalThis`, giving any
 *   third-party page in the preview full Node + IPC access to the host.
 * - `safeDialogs=true`: a page's `alert` opens a native sheet that blocks the
 *   whole ViewCode window, so a page looping `alert(); location.reload()` left
 *   no way to close its tab. This offers "Prevent additional dialogs" from the
 *   second dialog on.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false,safeDialogs=true";
