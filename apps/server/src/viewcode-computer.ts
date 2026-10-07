// Standalone entry for the agent-facing computer-use CLI, launched by the
// `viewcode-computer` shim: `viewcode-computer.mjs <command> [flags]`. The
// executable reaches the same CLI through `__viewcode-computer -- <args>`.
import { runComputerCliMain } from "./computerUse/ComputerUseCli.ts";

process.exitCode = await runComputerCliMain(process.argv.slice(2));
