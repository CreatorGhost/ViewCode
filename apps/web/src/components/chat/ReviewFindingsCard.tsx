import type {
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewFindingsActivityPayload,
  ReviewVerdict,
  ScopedThreadRef,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SEVERITY_LABELS,
  REVIEW_VERDICT_LABELS,
  reviewFindingLocation,
  reviewFindingMarkdown,
} from "@t3tools/shared/reviewFindings";
import { ChevronDownIcon, ListChecksIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface ReviewFindingsRenderContext {
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}

const VERDICT_BADGES: Record<ReviewVerdict, "success" | "info" | "warning"> = {
  approve: "success",
  "approve-with-nits": "info",
  "request-changes": "warning",
};

const SEVERITY_BADGES: Record<ReviewFindingSeverity, "error" | "warning" | "outline" | "info"> = {
  blocker: "error",
  important: "warning",
  nit: "outline",
  question: "info",
};

/** A finding's place in the payload: which list, and its index there. */
export type ReviewFindingKey = `${"finding" | "check"}:${number}`;

interface ReviewFindingRowProps {
  readonly finding: ReviewFinding;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly context: ReviewFindingsRenderContext;
}

function ReviewFindingRow({ finding, expanded, onToggle, context }: ReviewFindingRowProps) {
  return (
    <li className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <Badge size="sm" variant={SEVERITY_BADGES[finding.severity]}>
          {REVIEW_FINDING_SEVERITY_LABELS[finding.severity]}
        </Badge>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {finding.confidence}%
        </span>
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{finding.title}</span>
          <span className="ml-1.5 font-mono text-muted-foreground text-xs">
            {reviewFindingLocation(finding)}
          </span>
        </span>
        {finding.preExisting ? (
          <Badge size="sm" variant="outline">
            pre-existing
          </Badge>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          className="ml-auto"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse finding" : "Expand finding"}
          onClick={onToggle}
        >
          <ChevronDownIcon aria-hidden className={cn("size-3.5", expanded && "rotate-180")} />
        </Button>
      </div>
      {expanded ? (
        <div className="mt-1 min-w-0 text-sm">
          <ChatMarkdown
            className="text-foreground"
            text={reviewFindingMarkdown(finding)}
            cwd={context.markdownCwd}
            threadRef={context.threadRef ?? undefined}
            skills={context.skills}
            headingLevelOffset={4}
          />
        </div>
      ) : null}
    </li>
  );
}

function FindingGroup({
  label,
  findings,
  list,
  expanded,
  onToggle,
  context,
}: {
  readonly label: string;
  readonly findings: ReadonlyArray<{ readonly finding: ReviewFinding; readonly index: number }>;
  readonly list: "finding" | "check";
  readonly expanded: ReadonlySet<ReviewFindingKey>;
  readonly onToggle: (key: ReviewFindingKey) => void;
  readonly context: ReviewFindingsRenderContext;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="mt-2 min-w-0">
      <h4 className="text-muted-foreground text-xs">
        {label} ({findings.length})
      </h4>
      <ul className="min-w-0">
        {findings.map(({ finding, index }) => {
          const key: ReviewFindingKey = `${list}:${index}`;
          return (
            <ReviewFindingRow
              key={key}
              finding={finding}
              expanded={expanded.has(key)}
              onToggle={() => onToggle(key)}
              context={context}
            />
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The findings a reviewer submitted with `submit_review_findings`, under its written report:
 * the verdict and scores, then each finding by severity. A row expands to its detail and
 * suggested fix; nothing below a row renders until it is expanded.
 */
export function ReviewFindingsCard({
  findings,
  context,
}: {
  findings: ReviewFindingsActivityPayload;
  context: ReviewFindingsRenderContext;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const toggle = (key: ReviewFindingKey) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const indexed = findings.findings.map((finding, index) => ({ finding, index }));
  return (
    <div className="mx-auto w-full max-w-chat rounded-lg border border-border bg-card/40 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
        <ListChecksIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Review findings</span>
        <Badge size="sm" variant={VERDICT_BADGES[findings.verdict]}>
          {REVIEW_VERDICT_LABELS[findings.verdict]}
        </Badge>
        <span>
          Merge confidence {findings.mergeConfidence}/5 · Review effort {findings.reviewEffort}/5
        </span>
      </div>
      {findings.findings.length === 0 ? (
        <p className="mt-1 text-muted-foreground text-sm">No findings.</p>
      ) : null}
      {REVIEW_FINDING_SEVERITIES.map((severity) => (
        <FindingGroup
          key={severity}
          label={REVIEW_FINDING_SEVERITY_LABELS[severity]}
          findings={indexed.filter((entry) => entry.finding.severity === severity)}
          list="finding"
          expanded={expanded}
          onToggle={toggle}
          context={context}
        />
      ))}
      <FindingGroup
        label="Needs checking"
        findings={findings.needsChecking.map((finding, index) => ({ finding, index }))}
        list="check"
        expanded={expanded}
        onToggle={toggle}
        context={context}
      />
    </div>
  );
}
