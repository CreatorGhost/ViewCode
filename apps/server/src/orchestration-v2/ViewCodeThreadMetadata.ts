import type { ViewCodeThreadMetadata } from "@t3tools/contracts";

export function viewCodeThreadMetadata(thread: ViewCodeThreadMetadata): ViewCodeThreadMetadata {
  return {
    ...(thread.parentThreadId === undefined ? {} : { parentThreadId: thread.parentThreadId }),
    ...(thread.viewcodeMessageFork === undefined
      ? {}
      : { viewcodeMessageFork: thread.viewcodeMessageFork }),
    ...(thread.kind === undefined ? {} : { kind: thread.kind }),
    ...(thread.viewcodeGoal === undefined ? {} : { viewcodeGoal: thread.viewcodeGoal }),
    ...(thread.debugMode === undefined ? {} : { debugMode: thread.debugMode }),
  };
}
