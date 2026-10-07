// Standalone entry for the computer-use driver process, forked by the server
// with an IPC channel: `computer-use-driver.mjs`. The executable reaches the
// same worker through the `__computer-use-driver` subcommand.
import { runComputerUseDriverWorker } from "./computerUse/Xa11yDriverWorker.ts";

await runComputerUseDriverWorker();
