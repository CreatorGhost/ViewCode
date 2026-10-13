import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * One line above a list that has rows, naming the repositories that could not be read. Without
 * it a repository the host refused simply has no rows, which reads as having no pull requests.
 * Several fold behind a toggle so the line stays one line.
 */
export function PullRequestListUnreadableNotice({
  unavailableProjects,
}: {
  /** Project name to the reason it could not be read. */
  unavailableProjects: ReadonlyMap<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const unavailable = [...unavailableProjects];
  const [first] = unavailable;
  if (first === undefined) return null;
  const count = `${unavailable.length} ${unavailable.length === 1 ? "repository" : "repositories"}`;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>
        {unavailable.length === 1 ? (
          // Not truncated: the reason is the whole point, and it is one sentence.
          <span>
            Couldn't read {count}: {first[0]} — {first[1]}
          </span>
        ) : expanded ? (
          <ul className="space-y-1">
            {unavailable.map(([project, reason]) => (
              <li key={project}>
                {project} — {reason}
              </li>
            ))}
          </ul>
        ) : (
          <span className="truncate">
            Couldn't read {count}: {unavailable.map(([project]) => project).join(", ")}
          </span>
        )}
      </AlertDescription>
      {unavailable.length > 1 ? (
        <AlertAction>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide" : "Details"}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
