import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { createContext, use, useEffect, useState, type ReactNode } from "react";

import { useSplitPaneFocused } from "../../splitView/SplitPaneContext";
import { useServerConfigs, useThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { REVIEW_FIX_UNDO_OPEN_EVENT, ReviewFixUndoDialog } from "./ReviewFixUndoDialog";
import { viewCodeReviewFixUndo } from "./viewcodeReviewFixUndo";

const UndoContext = createContext<{ readonly turnCount: number; readonly open: () => void } | null>(
  null,
);

/** One subscription and dialog per chat; timeline rows only consume the stable undo target. */
export function ViewCodeReviewFixUndoHost({
  threadRef,
  children,
}: {
  threadRef: ScopedThreadRef | null;
  children: ReactNode;
}) {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const configs = useServerConfigs();
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const focused = useSplitPaneFocused();
  const target = viewCodeReviewFixUndo(projection);
  const canUndo =
    threadRef !== null &&
    canOperate &&
    configs.get(threadRef.environmentId)?.environment.capabilities.reviewFixUndo === true &&
    target !== null &&
    target.undoneTurns > 0;
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const [openThreadKey, setOpenThreadKey] = useState<string | null>(null);
  const open = () => setOpenThreadKey(threadKey);
  const turnCount = target?.turnCount ?? null;
  const action = canUndo && turnCount !== null ? { turnCount, open } : null;
  useEffect(() => {
    if (!focused || action === null) return;
    window.addEventListener(REVIEW_FIX_UNDO_OPEN_EVENT, action.open);
    return () => window.removeEventListener(REVIEW_FIX_UNDO_OPEN_EVENT, action.open);
  }, [focused, action]);
  return (
    <UndoContext value={action}>
      {children}
      {canUndo && threadRef !== null && openThreadKey === threadKey ? (
        <ReviewFixUndoDialog
          key={threadKey}
          threadRef={threadRef}
          undoneTurns={target.undoneTurns}
          onClose={() => setOpenThreadKey(null)}
        />
      ) : null}
    </UndoContext>
  );
}

/** Render only at the fix's first user message, beside native rollback/fork controls. */
export function ViewCodeReviewFixUndoButton({
  runOrdinal,
  disabled,
}: {
  runOrdinal: number | null;
  disabled: boolean;
}) {
  const action = use(UndoContext);
  if (action === null || runOrdinal !== action.turnCount + 1) return null;
  return (
    <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={action.open}>
      Undo review fixes
    </Button>
  );
}
