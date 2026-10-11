import { buildSidechatCreateInput } from "@t3tools/client-runtime/state/sidechat";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Sends questions only to the side chat; the server supplies its parent's context. */
export function useSidechatActions() {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (input: {
    readonly parent: EnvironmentThreadShell;
    readonly sidechat: EnvironmentThreadShell | null;
    readonly question: string;
    readonly onCreated: (threadId: ThreadId) => void;
  }) => {
    if (pendingRef.current) return null;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const target = input.sidechat ?? input.parent;
      const threadId = input.sidechat?.id ?? ThreadId.make(uuidv4());
      if (input.sidechat === null) {
        const created = await createThread({
          environmentId: input.parent.environmentId,
          input: buildSidechatCreateInput({
            parent: input.parent,
            threadId,
            question: input.question,
          }),
        });
        if (created._tag === "Failure") {
          if (!isAtomCommandInterrupted(created)) {
            const failure = squashAtomCommandFailure(created);
            setError(failure instanceof Error ? failure.message : "Could not start side chat.");
          }
          return null;
        }
        // Select the created thread even if sending fails, so retry never creates a second one.
        input.onCreated(threadId);
      }
      const messageId = MessageId.make(uuidv4());
      const sent = await startTurn({
        environmentId: target.environmentId,
        input: {
          threadId,
          message: { messageId, role: "user", text: input.question, attachments: [] },
          modelSelection: target.modelSelection,
          runtimeMode: target.runtimeMode,
          interactionMode: "default",
        },
      });
      if (sent._tag === "Failure") {
        if (!isAtomCommandInterrupted(sent)) {
          const failure = squashAtomCommandFailure(sent);
          setError(failure instanceof Error ? failure.message : "Could not send question.");
        }
        return null;
      }
      return messageId;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const stop = async (sidechat: EnvironmentThreadShell) => {
    setError(null);
    const result = await interruptTurn({
      environmentId: sidechat.environmentId,
      input: { threadId: sidechat.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not stop side chat.");
    }
  };

  return { send, stop, pending, error, clearError: () => setError(null) };
}
