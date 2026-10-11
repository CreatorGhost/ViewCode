import {
  filterReviewCommits,
  localReviewScopeLabel,
  pastedReviewCommitSha,
} from "@t3tools/client-runtime/agent-review";
import type { EnvironmentId, LocalReviewScope } from "@t3tools/contracts";
import { GitCommitHorizontalIcon } from "lucide-react";
import { useId, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type ScopeKind = "auto" | LocalReviewScope["kind"];

/**
 * What of a checkout's changes a review reads: left to the reviewer, the uncommitted changes, the
 * branch against a base (the remote's default branch until the reader names another), or one
 * commit picked from the latest ones or pasted.
 */
export function ReviewScopeFields({
  environmentId,
  cwd,
  scope,
  onScopeChange,
}: {
  environmentId: EnvironmentId;
  /** The checkout whose commits and base are offered. */
  cwd: string | null;
  scope: LocalReviewScope | null;
  onScopeChange: (scope: LocalReviewScope | null) => void;
}) {
  const id = useId();
  const kind: ScopeKind = scope?.kind ?? "auto";
  const needsCheckout = kind === "branch" || kind === "commit";
  const listed = useEnvironmentQuery(
    needsCheckout && cwd !== null
      ? reviewEnvironment.commits({ environmentId, input: { cwd } })
      : null,
  );
  const detectedBase = listed.data?.base ?? null;
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-scope`} className="font-medium text-xs text-muted-foreground">
        What to review
      </span>
      <ToggleGroup
        aria-labelledby={`${id}-scope`}
        className="w-full *:flex-1"
        value={[kind]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "auto") onScopeChange(null);
          if (value === "uncommitted") onScopeChange({ kind: "uncommitted" });
          if (value === "branch") {
            onScopeChange(
              detectedBase === null ? { kind: "branch" } : { kind: "branch", base: detectedBase },
            );
          }
          // A commit is chosen from the list below; until then nothing can be sent.
          if (value === "commit") onScopeChange({ kind: "commit", sha: "" });
        }}
      >
        <Toggle value="auto">Auto</Toggle>
        <Toggle value="uncommitted">Uncommitted</Toggle>
        <Toggle value="branch">Branch</Toggle>
        <Toggle value="commit">Commit</Toggle>
      </ToggleGroup>
      {scope?.kind === "branch" ? (
        <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-base`}>
          Compare against
          <Input
            id={`${id}-base`}
            placeholder={detectedBase ?? "The remote's default branch"}
            value={scope.base ?? ""}
            onChange={(event) => {
              const base = event.target.value.trim();
              onScopeChange(base.length > 0 ? { kind: "branch", base } : { kind: "branch" });
            }}
          />
        </Label>
      ) : scope?.kind === "commit" ? (
        <ReviewCommitPicker
          commits={listed.data?.commits ?? []}
          pending={listed.isPending}
          selectedSha={scope.sha}
          onPick={(sha) => onScopeChange({ kind: "commit", sha })}
        />
      ) : (
        <span className="text-xs text-muted-foreground">
          {kind === "auto"
            ? "The uncommitted changes, or the branch against its base when everything is committed."
            : localReviewScopeLabel(scope)}
        </span>
      )}
    </div>
  );
}

/** The checkout's latest commits to pick one from, with a pasted SHA as a choice of its own. */
function ReviewCommitPicker({
  commits,
  pending,
  selectedSha,
  onPick,
}: {
  commits: ReadonlyArray<{
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly author: string;
    readonly committedAt: string;
  }>;
  pending: boolean;
  selectedSha: string;
  onPick: (sha: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = filterReviewCommits(commits, query);
  const pasted = pastedReviewCommitSha(query);
  const pastedListed = pasted !== null && shown.some((commit) => commit.sha.startsWith(pasted));
  return (
    <div className="rounded-lg border">
      <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose a commit">
        <CommandInput placeholder="Search commits, or paste a SHA" />
        <CommandList className="max-h-56 overflow-y-auto">
          {pasted !== null && !pastedListed ? (
            <CommandItem value={`sha:${pasted}`} onClick={() => onPick(pasted)}>
              <GitCommitHorizontalIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">Review commit {pasted}</span>
            </CommandItem>
          ) : null}
          {shown.map((commit) => (
            <CommandItem
              key={commit.sha}
              value={commit.sha}
              aria-selected={commit.sha === selectedSha}
              onClick={() => onPick(commit.sha)}
            >
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {commit.shortSha}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{commit.subject || "(no subject)"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {commit.author} · {formatRelativeTimeLabel(commit.committedAt)}
                </span>
              </span>
              {commit.sha === selectedSha ? (
                <span className="shrink-0 text-xs text-foreground">Chosen</span>
              ) : null}
            </CommandItem>
          ))}
          {shown.length === 0 && pasted === null ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              {pending ? "Loading commits..." : "No commits match."}
            </div>
          ) : null}
        </CommandList>
      </Command>
      {selectedSha.length > 0 && !commits.some((commit) => commit.sha === selectedSha) ? (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          Reviewing commit {selectedSha}
        </p>
      ) : null}
    </div>
  );
}
