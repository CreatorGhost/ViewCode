import * as Context from "effect/Context";
export {
  Platform as HostProcessPlatform,
  Environment as HostProcessEnvironment,
  ExecutablePath as HostProcessExecutablePath,
  IsExecutable as HostProcessIsExecutable,
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
