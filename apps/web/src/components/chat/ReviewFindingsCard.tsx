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
import { ChevronDownIcon, ListChecksIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ReviewFixDialog, type ReviewFixItem } from "./ReviewFixDialog";
import { type ReviewFixDestination, useReviewFixSentStore } from "./reviewFixSentStore";

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
type ReviewFindingKey = `${"finding" | "check"}:${number}`;

const EMPTY_SENT: Readonly<Record<string, ReviewFixDestination>> = {};

interface ReviewFindingRowProps {
  readonly finding: ReviewFinding;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly context: ReviewFindingsRenderContext;
  /** Absent for a row that cannot be ticked for "Fix all" (needs checking). */
  readonly ticked?: boolean;
  readonly onTick?: (ticked: boolean) => void;
  readonly onFix: (() => void) | null;
  readonly sentTo: ReviewFixDestination | undefined;
}

function ReviewFindingRow({
  finding,
  expanded,
  onToggle,
  context,
  ticked,
  onTick,
  onFix,
  sentTo,
}: ReviewFindingRowProps) {
  return (
    <li className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        {onTick ? (
          <Checkbox
            aria-label={`Include "${finding.title}" in Fix all`}
            checked={ticked === true}
            onCheckedChange={(checked) => onTick(checked === true)}
          />
        ) : null}
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
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {sentTo ? (
            <span className="max-w-40 truncate text-muted-foreground text-xs">
              Sent to {sentTo.title}
            </span>
          ) : null}
          {onFix ? (
            <Button type="button" size="xs" variant="ghost" onClick={onFix}>
              {sentTo ? "Fix again" : "Fix"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse finding" : "Expand finding"}
            onClick={onToggle}
          >
            <ChevronDownIcon aria-hidden className={cn("size-3.5", expanded && "rotate-180")} />
          </Button>
        </span>
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

/**
 * The findings a reviewer submitted with `submit_review_findings`, under its written report:
 * the verdict and scores, then each finding by severity. A row expands to its detail and
 * suggested fix; nothing below a row renders until it is expanded. Fix sends one finding to a
 * coding session, Fix all the ticked findings in one message; needs-checking items go one at a
 * time. A finding already sent says where and starts unticked.
 */
export function ReviewFindingsCard({
  activityId,
  findings,
  context,
}: {
  activityId: string;
  findings: ReviewFindingsActivityPayload;
  context: ReviewFindingsRenderContext;
}) {
  const { threadRef } = context;
  const cardKey = threadRef ? `${threadRef.environmentId}:${activityId}` : activityId;
  const sent = useReviewFixSentStore((state) => state.sentByCard[cardKey] ?? EMPTY_SENT);
  const [expanded, setExpanded] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  // Only the reader's own ticks; the default is every finding not sent yet.
  const [ticks, setTicks] = useState<ReadonlyMap<ReviewFindingKey, boolean>>(() => new Map());
  const [fixing, setFixing] = useState<ReadonlyArray<ReviewFixItem> | null>(null);

  const toggle = (key: ReviewFindingKey) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const isTicked = (key: ReviewFindingKey) => ticks.get(key) ?? sent[key] === undefined;
  const fixItem = (key: ReviewFindingKey, finding: ReviewFinding): ReviewFixItem => ({
    key,
    item: { finding, needsChecking: key.startsWith("check:") },
  });
  const canFix = threadRef !== null;

  const indexed = findings.findings.map((finding, index) => ({
    finding,
    key: `finding:${index}` as const,
  }));
  const tickedItems = indexed
    .filter((entry) => isTicked(entry.key))
    .map((entry) => fixItem(entry.key, entry.finding));
  const renderRow = (key: ReviewFindingKey, finding: ReviewFinding, tickable: boolean) => (
    <ReviewFindingRow
      key={key}
      finding={finding}
      expanded={expanded.has(key)}
      onToggle={() => toggle(key)}
      context={context}
      {...(tickable && canFix
        ? {
            ticked: isTicked(key),
            onTick: (value: boolean) => setTicks((current) => new Map(current).set(key, value)),
          }
        : {})}
      onFix={canFix ? () => setFixing([fixItem(key, finding)]) : null}
      sentTo={sent[key]}
    />
  );

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
      {REVIEW_FINDING_SEVERITIES.map((severity) => {
        const group = indexed.filter((entry) => entry.finding.severity === severity);
        if (group.length === 0) return null;
        return (
          <section key={severity} className="mt-2 min-w-0">
            <h4 className="text-muted-foreground text-xs">
              {REVIEW_FINDING_SEVERITY_LABELS[severity]} ({group.length})
            </h4>
            <ul className="min-w-0">
              {group.map((entry) => renderRow(entry.key, entry.finding, true))}
            </ul>
          </section>
        );
      })}
      {findings.needsChecking.length > 0 ? (
        <section className="mt-2 min-w-0">
          <h4 className="text-muted-foreground text-xs">
            Needs checking ({findings.needsChecking.length})
          </h4>
          <ul className="min-w-0">
            {findings.needsChecking.map((finding, index) =>
              renderRow(`check:${index}`, finding, false),
            )}
          </ul>
        </section>
      ) : null}
      {canFix && findings.findings.length > 0 ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={tickedItems.length === 0}
            onClick={() => setFixing(tickedItems)}
          >
            <WrenchIcon aria-hidden />
            {tickedItems.length === findings.findings.length
              ? "Fix all"
              : `Fix ${tickedItems.length} selected`}
          </Button>
        </div>
      ) : null}
      {fixing !== null && threadRef !== null ? (
        <ReviewFixDialog
          reviewThreadRef={threadRef}
          cardKey={cardKey}
          target={findings.target}
          items={fixing}
          onClose={() => setFixing(null)}
        />
      ) : null}
    </div>
  );
}
