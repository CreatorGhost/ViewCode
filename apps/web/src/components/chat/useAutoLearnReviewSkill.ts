import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useServerConfigs } from "../../state/entities";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";

/** Projects already asked about since the app started, so each is asked about once. */
const asked = new Set<string>();

/**
 * Asks the server to learn a project's review skill when one of its chats is opened. The server
 * decides whether to: only when it never learned the project, nothing is learning, and its
 * setting allows it. Nothing here waits on the answer or reports a failure.
 */
export function useAutoLearnReviewSkill(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): void {
  const supported =
    useServerConfigs().get(environmentId ?? ("" as EnvironmentId))?.environment.capabilities
      .reviewSkill === true;
  const learnSkill = useAtomCommand(reviewEnvironment.learnSkill, { reportFailure: false });
  useEffect(() => {
    if (!supported || environmentId === null || projectId === null) return;
    const key = `${environmentId}:${projectId}`;
    if (asked.has(key)) return;
    asked.add(key);
    void learnSkill({ environmentId, input: { projectId, auto: true } });
  }, [environmentId, learnSkill, projectId, supported]);
}
