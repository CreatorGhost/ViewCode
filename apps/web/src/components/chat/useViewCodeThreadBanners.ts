import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { viewCodeThread } from "@t3tools/client-runtime/viewcodeThread";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { WorkLogEntry } from "../../session-logic";
import { useClaudeCacheBanner } from "./useClaudeCacheBanner";
import { useImagePayloadBanner } from "./useImagePayloadBanner";
import { useLiveEditedFilesBanner } from "./useLiveEditedFilesBanner";
import { useUsageResumeBanner } from "./useUsageResumeBanner";
import { useViewcodeToolsBanner } from "./useViewcodeToolsBanner";

export function useViewCodeThreadBanners(input: {
  threadRef: ScopedThreadRef | null;
  projection: OrchestrationV2ThreadProjection | null;
  provider: string | null | undefined;
  running: boolean;
  entries: ReadonlyArray<WorkLogEntry>;
  runningRunId: string | null;
  workspaceRoot: string | undefined;
  contextWindow: ContextWindowSnapshot | null;
  onCompact: (() => void) | null;
  onOpenWorkingTreeDiff: (filePath?: string) => void;
}) {
  const thread = input.projection === null ? null : viewCodeThread(input.projection);
  const threadId = input.threadRef?.threadId ?? null;
  const usage = useUsageResumeBanner({
    threadRef: input.threadRef,
    activities: thread?.activities ?? [],
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
  });
  const images = useImagePayloadBanner({
    threadId,
    messages: thread?.messages ?? [],
    providerName: input.provider,
  });
  const tools = useViewcodeToolsBanner({
    threadId,
    activities: thread?.activities ?? [],
    sessionProviderName: thread?.session?.providerName,
  });
  const { item: cache } = useClaudeCacheBanner({
    threadId,
    isClaude: input.provider === "claudeAgent" && thread?.session?.providerName === "claudeAgent",
    running: input.running,
    model: input.projection?.thread.modelSelection.model,
    contextWindow: input.contextWindow,
    onCompact: input.onCompact,
  });
  const files = useLiveEditedFilesBanner({
    entries: input.entries,
    runningTurnId: input.runningRunId,
    workspaceRoot: input.workspaceRoot,
    onOpenWorkingTreeDiff: input.onOpenWorkingTreeDiff,
  });
  return { usage, items: [usage, images, tools, cache, files].filter((item) => item !== null) };
}
