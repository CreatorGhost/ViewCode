import type { ReviewFindingsSource } from "@t3tools/client-runtime/review-findings";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  type ReviewFinding,
  type ReviewSkillLesson,
  type ReviewFindingRating,
  ThreadId,
} from "@t3tools/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";

import { ReviewSkillLessonList } from "~/components/chat/RepositoryLessons";
import { ReviewFindingsView } from "~/components/chat/ReviewFindingsView";
import { ReviewStartForm } from "~/components/chat/ReviewStart";
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
      {
        severity: "blocker",
        confidence: 92,
        path: "backend/db/migrations/0042_add_owner.sql",
        line: 7,
        title: "Migration adds NOT NULL without a backfill",
        detail:
          "Existing rows in playbooks have no owner_id, so this migration fails on any database that already has playbooks. The deploy runs migrations before the app starts, so the release stops there.",
        suggestedFix:
          "UPDATE playbooks SET owner_id = created_by WHERE owner_id IS NULL;\nALTER TABLE playbooks ALTER COLUMN owner_id SET NOT NULL;",
        lesson: {
          text: "NOT NULL columns need a backfill",
          occurrences: 4,
          evidence: [1212, 1340, 1377, 1398].map((number) => ({
            label: `#${number}`,
            url: `https://github.com/example/agents/pull/${number}`,
          })),
        },
      },
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

const LOOK_FIRST = [
  "migration",
  "CI workflow",
  "2 major dependency bumps",
  "removed export parseRef",
];
const RATINGS: ReadonlyMap<string, ReviewFindingRating> = new Map([["finding:5", "down"]]);
const lesson = (
  text: string,
  where: string,
  source: ReviewSkillLesson["source"],
  pullRequests: ReadonlyArray<number>,
  rated: readonly [helpful: number, unhelpful: number],
  off = false,
) =>
  ({
    id: text.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    text,
    where,
    source,
    evidence: pullRequests.map((number) => ({
      label: `#${number}`,
      url: `https://github.com/example/agents/pull/${number}`,
    })),
    enabled: !off,
    ...(off ? { disabledByRatings: true } : {}),
    helpful: rated[0],
    unhelpful: rated[1],
  }) as ReviewSkillLesson;
const LESSONS: ReadonlyArray<ReviewSkillLesson> = [
  lesson("Never log callback tokens", "agents/**", "yours", [], [0, 0]),
  lesson(
    "NOT NULL columns need a backfill",
    "backend/db/migrations/**",
    "kept-breaking",
    [1212, 1340, 1377, 1398],
    [5, 1],
  ),
  lesson(
    "Lock playbook rows before callback rows",
    "agents/playbooks/**",
    "kept-breaking",
    [1105, 1290, 1466],
    [3, 0],
  ),
  lesson(
    "API schema changes need the frontend client regenerated",
    "backend/core/schemas/**",
    "reviewers-ask",
    [1188, 1502],
    [2, 0],
  ),
  lesson("Docstrings on test helpers", "**/tests/**", "reviewers-ask", [1410, 1422], [0, 3], true),
];

function ReviewFindingsPreview() {
  const [superseded, setSuperseded] = useState(true);
  const [lessons, setLessons] = useState(LESSONS);
  const [startedAt] = useState(() => new Date(Date.now() - 79 * 60_000).toISOString());
  const environmentId = [...useServerConfigs().keys()][0] ?? EnvironmentId.make("env-local");
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-background p-10">
      <Button variant="outline" size="xs" onClick={() => setSuperseded((value) => !value)}>
        {superseded ? "Newer review running" : "These are the latest"}
      </Button>
      <div data-preview="start" className="w-80 rounded-xl border bg-popover p-4 shadow-lg">
        <ReviewStartForm
          target={{
            environmentId,
            request: {
              kind: "local",
              projectId: ProjectId.make("project-preview"),
              sourceThreadId: ThreadId.make("thread-preview"),
            },
            onStarted: () => {},
          }}
        />
      </div>
      <div data-preview="lessons" className="w-160 rounded-xl border bg-card p-4">
        <ReviewSkillLessonList
          lessons={lessons}
          disabled={false}
          onToggle={(changed, enabled) =>
            setLessons((current) =>
              current.map((entry) => (entry.id === changed.id ? { ...entry, enabled } : entry)),
            )
          }
          onRemove={(removed) =>
            setLessons((current) => current.filter((entry) => entry.id !== removed.id))
          }
        />
      </div>
      <div
        data-preview="panel"
        className="flex h-225 w-100 flex-col border-border border-x bg-background"
      >
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
        <div className="min-h-0 flex-1 px-3 pt-2 pb-3">
          <ReviewFindingsView
            environmentId={environmentId}
            threadRef={null}
            source={source}
            projectId={null}
            cwd={undefined}
            posted={new Map()}
            ratings={RATINGS}
            onFixInChat={undefined}
            startReview={null}
            stillReviewing={false}
            superseded={superseded}
            readerScrolled={() => false}
            lookFirst={LOOK_FIRST}
          />
        </div>
      </div>
    </div>
  );
}
