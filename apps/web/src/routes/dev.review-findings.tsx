import type { ReviewFindingsSource } from "@t3tools/client-runtime/review-findings";
import { EnvironmentId, EventId, type ReviewFinding, ThreadId } from "@t3tools/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";

import { ReviewFindingsView } from "~/components/chat/ReviewFindingsView";
import { ReviewCard } from "~/components/chat/ReviewProgress";
import { Button } from "~/components/ui/button";
import { useServerConfigs } from "~/state/entities";

/**
 * Development preview of the Review panel's findings: the earlier review's issues under a newer
 * review at work, and the same issues as the latest. Not in production builds.
 */
export const Route = createFileRoute("/dev/review-findings")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: ReviewFindingsPreview,
});

const finding = (
  severity: ReviewFinding["severity"],
  title: string,
  path: string,
  line: number,
): ReviewFinding => ({
  severity,
  confidence: 80,
  path,
  line,
  title,
  detail: "The problem, why it matters and the path from a caller to it.",
});

const source: ReviewFindingsSource = {
  threadId: ThreadId.make("review-1615"),
  threadTitle:
    "Deep review: #1615 feat(playbooks): MGAI-1120 wait for External API Call results through callbacks",
  activityId: EventId.make("evt-1"),
  createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  scope: null,
  findings: {
    verdict: "request-changes",
    mergeConfidence: 3,
    reviewEffort: 4,
    target: {
      kind: "pull-request",
      host: "github.com",
      repository: "example/agents",
      number: 1615,
      url: "https://github.com/example/agents/pull/1615",
    },
    mode: "fix",
    needsChecking: [],
    findings: [
      finding(
        "important",
        "Revoking a callback key skips playbook execute permission",
        "backend/core/handlers/apiKeysHandler.js",
        88,
      ),
      finding(
        "important",
        "Waiting tick and callback lock rows in opposite order",
        "agents/playbooks/callback.py",
        131,
      ),
      finding(
        "important",
        "successField fails an accepted callback with no body",
        "agents/playbooks/external_api.py",
        243,
      ),
      finding(
        "nit",
        "Callback header can be added in the editor twice",
        "frontend/src/features/playbooks/components/CallbackHeaders.tsx",
        42,
      ),
      finding(
        "nit",
        "Three new or grown functions exceed 20 lines",
        "agents/playbooks/callback.py",
        151,
      ),
      finding(
        "nit",
        "Body field collision still enables save",
        "frontend/src/features/playbooks/components/BodyFields.tsx",
        77,
      ),
      finding(
        "question",
        "Should a cancelled wait step release its callback key?",
        "agents/playbooks/wait.py",
        12,
      ),
    ],
  },
};

function ReviewFindingsPreview() {
  const [superseded, setSuperseded] = useState(true);
  const [startedAt] = useState(() => new Date(Date.now() - 79 * 60_000).toISOString());
  const environmentId = [...useServerConfigs().keys()][0] ?? EnvironmentId.make("env-local");
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-background p-10">
      <Button variant="outline" size="xs" onClick={() => setSuperseded((value) => !value)}>
        {superseded ? "Newer review running" : "These are the latest"}
      </Button>
      <div className="flex h-150 w-100 flex-col border-border border-x bg-background">
        {superseded ? (
          <ReviewCard
            icon={null}
            kicker="Reviewing now"
            kickerVariant="info"
            heading={{
              kind: "pull-request",
              number: 1810,
              title: "feat(playbooks): validate run and preview bodies against a shared schema",
            }}
            mode="Deep review"
            model="Claude Sonnet 5.5"
            startedAt={startedAt}
            state={{ kind: "running" }}
            title="Deep review: #1810 feat(playbooks): validate run and preview bodies"
            tree={
              <p className="px-0.5 text-muted-foreground text-xs">Running tests in frontend…</p>
            }
            onViewAgent={() => {}}
            onStop={() => {}}
            stopping={false}
            onRetry={null}
            retrying={false}
          />
        ) : null}
        <div className="min-h-0 flex-1">
          <ReviewFindingsView
            environmentId={environmentId}
            threadRef={null}
            source={source}
            projectId={null}
            cwd={undefined}
            posted={new Map()}
            ratings={new Map()}
            onFixInChat={undefined}
            startReview={null}
            stillReviewing={false}
            superseded={superseded}
            readerScrolled={() => false}
          />
        </div>
      </div>
    </div>
  );
}
