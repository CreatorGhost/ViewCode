import type { EnvironmentId, LearnedReviewStyleSample } from "@t3tools/contracts";
import { reviewStyleKey } from "@t3tools/shared/reviewFindings";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/** The server's bound on a style, which is also all of it a reviewer's first message can carry. */
const REVIEW_STYLE_MAX_CHARS = 4_000;

/**
 * How this account writes review comments. A reviewer whose findings will be posted to somebody
 * else's pull request as this account writes them this way. Saved on the server, per account.
 */
export function PullRequestReviewStyleSettings({
  environmentId,
  host,
  login,
}: {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly login: string;
}) {
  const id = useId();
  const key = reviewStyleKey(host, login);
  const saved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.pullRequestReviewStyles[key] ?? "",
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save your review style",
  });
  const canLearn =
    useServerConfigs().get(environmentId)?.environment.capabilities.learnedReviewStyle === true;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const dirty = value.trim() !== saved;

  const save = async () => {
    setSaving(true);
    try {
      // The server merges per account, and an empty style clears this one's.
      const result = await updateSettings({
        environmentId,
        input: { patch: { pullRequestReviewStyles: { [key]: value.trim() } } },
      });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4">
      {canLearn ? (
        <LearnedReviewStyleSettings environmentId={environmentId} host={host} login={login} />
      ) : null}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) void save();
        }}
      >
        <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-style`}>
          Your review style
          <Textarea
            id={`${id}-style`}
            rows={4}
            value={value}
            maxLength={REVIEW_STYLE_MAX_CHARS}
            disabled={saving}
            placeholder="For example: short and direct, no praise padding, suggest code instead of describing it."
            onChange={(event) => setDraft(event.target.value)}
          />
        </Label>
        <p className="text-muted-foreground text-xs">
          How you write review comments as {login}. An agent reviewing somebody else's pull request
          writes its findings this way before you post them
          {canLearn ? ", and this wins over what it learned from your reviews." : "."}
        </p>
        <div className="flex justify-end gap-2">
          {dirty ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="xs" disabled={!dirty || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

const SAMPLE_LABELS: Record<LearnedReviewStyleSample["state"], string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
};

/**
 * The account's own review comments the server learned from, read from GitHub as that account.
 * Shows how many and a few of them, so the user can see what the reviewer will imitate.
 */
function LearnedReviewStyleSettings({
  environmentId,
  host,
  login,
}: {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly login: string;
}) {
  const status = useEnvironmentQuery(
    reviewEnvironment.learnedStyle({ environmentId, input: { host, login } }),
  );
  const learnStyle = useAtomCommand(reviewEnvironment.learnStyle, {
    label: "learn from your reviews",
  });
  const forgetLearnedStyle = useAtomCommand(reviewEnvironment.forgetLearnedStyle, {
    label: "forget what was learned from your reviews",
  });
  const [busy, setBusy] = useState<"learn" | "forget" | null>(null);
  const learned = status.data;

  const run = async (action: "learn" | "forget") => {
    setBusy(action);
    try {
      const input = { environmentId, input: { host, login } };
      await (action === "learn" ? learnStyle(input) : forgetLearnedStyle(input));
      status.refresh();
    } finally {
      setBusy(null);
    }
  };

  const summary =
    learned === null
      ? `Learn how you write from your own review comments as ${login}.`
      : learned.sampleCount === 0
        ? `Found none of your review comments to learn from · ${formatDate(learned.fetchedAt)}`
        : `Learned from ${learned.sampleCount} of your review comments · ${formatDate(learned.fetchedAt)}`;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-muted-foreground text-xs">
          {status.isSuccess || status.error !== null ? summary : "Checking..."}
        </p>
        <div className="flex gap-2">
          {learned !== null ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("forget")}
            >
              {busy === "forget" ? "Forgetting..." : "Forget"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("learn")}
          >
            {busy === "learn"
              ? "Learning..."
              : learned === null
                ? "Learn from my reviews"
                : "Learn again"}
          </Button>
        </div>
      </div>
      {learned !== null && learned.preview.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" size="xs" variant="ghost-muted" />}>
            What it learned from
            <ChevronDownIcon aria-hidden />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="grid gap-2 pt-1">
              {learned.preview.map((sample) => (
                // The server keeps no two samples with the same text.
                <li key={sample.text} className="rounded-md border border-border px-3 py-2 text-xs">
                  <p className="text-muted-foreground">
                    {sample.kind === "inline" ? "Line comment" : "Review"} ·{" "}
                    {SAMPLE_LABELS[sample.state]}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{sample.text}</p>
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
