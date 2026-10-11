import type { EnvironmentId } from "@t3tools/contracts";
import { reviewStyleKey } from "@t3tools/shared/reviewFindings";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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
        writes its findings this way before you post them.
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
  );
}
