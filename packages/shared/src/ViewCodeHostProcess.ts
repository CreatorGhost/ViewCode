import * as Context from "effect/Context";
export {
  Platform as HostProcessPlatform,
  Architecture as HostProcessArchitecture,
  Hostname as HostProcessHostname,
  Environment as HostProcessEnvironment,
  WorkingDirectory as HostProcessWorkingDirectory,
  ExecutablePath as HostProcessExecutablePath,
  Arguments as HostProcessArguments,
  InvokedAs as HostProcessInvokedAs,
  IsExecutable as HostProcessIsExecutable,
  Addresses as HostProcessAddresses,
  UserId as HostProcessUserId,
  isWindows as isHostWindows,
} from "./HostProcess.ts";
export const HostProcessOnShutdown = Context.Reference<(callback: () => void) => () => void>(
  "@t3tools/shared/hostProcess/HostProcessOnShutdown",
  {
    defaultValue: () => (callback) => {
      process.once("SIGTERM", callback);
      process.once("SIGINT", callback);
      return () => {
        process.off("SIGTERM", callback);
        process.off("SIGINT", callback);
      };
    },
  },
);
