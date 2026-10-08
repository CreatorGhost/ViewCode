// @effect-diagnostics nodeBuiltinImport:off - runs in the plain Node driver worker.
import * as NodeChildProcess from "node:child_process";

/** Activate the exact running instance; a bundle name can select another profile or dev app. */
export const MAC_APP_ACTIVATION_SCRIPT = `ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
function run(args) {
  var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (!target) throw Error("The target application is unavailable.");
  if (!target.activateWithOptions($.NSApplicationActivateIgnoringOtherApps))
    throw Error("The target application refused activation.");
}`;

export const activateMacApp = async (pid: number): Promise<void> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid application PID.");
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_APP_ACTIVATION_SCRIPT, String(pid)],
      { timeout: 2_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
};
