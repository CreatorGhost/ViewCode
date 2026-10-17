import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { ThreadGoalChip } from "./ThreadGoalChip";
import { ThreadGoalDialog } from "./ThreadGoalDialog";
import { useThreadGoalControls } from "./useThreadGoalControls";

export function ViewCodeThreadControls({
  threadRef,
  isServerThread,
  draftTarget,
}: {
  threadRef: ScopedThreadRef;
  isServerThread: boolean;
  draftTarget: ComposerThreadTarget;
}) {
  const shell = useThreadShell(isServerThread ? threadRef : null);
  const draft = useComposerDraftStore((store) =>
    isServerThread ? null : store.getDraftThread(draftTarget),
  );
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const controls = useThreadGoalControls({
    threadKey: scopedThreadKey(threadRef),
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    isServerThread,
    serverGoal: shell?.source.viewcodeGoal,
    serverDebugMode: shell?.source.debugMode,
    draftTarget,
    draftGoal: draft?.goal,
    draftDebugMode: draft?.debugMode,
  });
  return (
    <div className="flex shrink-0 items-center gap-1">
      {controls.goal !== null ? (
        <ThreadGoalChip disabled={!canOperate} goal={controls.goal} onEdit={controls.openEditor} />
      ) : (
        <Button size="xs" variant="ghost" disabled={!canOperate} onClick={controls.openEditor}>
          Goal
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        disabled={!canOperate}
        aria-pressed={controls.debugMode}
        onClick={() => controls.setDebugMode(!controls.debugMode)}
      >
        Debug
      </Button>
      {canOperate && controls.editorOpen ? (
        <ThreadGoalDialog
          goal={controls.goal}
          canPause={isServerThread}
          onSave={controls.saveGoal}
          onSetPaused={controls.setGoalPaused}
          onClear={controls.clearGoal}
          onClose={controls.closeEditor}
        />
      ) : null}
    </div>
  );
}
