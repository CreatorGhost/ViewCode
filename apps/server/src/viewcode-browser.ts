// Standalone entry for the agent-facing browser CLI, launched by the
// `viewcode-browser` shim: `viewcode-browser.mjs <command> [flags]`. The
// executable reaches the same CLI through `__viewcode-browser -- <args>`.
import { runBrowserCliMain } from "./browserCli/BrowserCli.ts";

process.exitCode = await runBrowserCliMain(process.argv.slice(2));
