import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ReviewSkillEdit } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReviewSkillLessonList } from "../chat/RepositoryLessons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const LESSON_MAX_CHARS = 200;

/**
 * The project's review skill: what its history taught, which every agent review of it looks for.
 * Learned by an agent in the background; here the user reads it, switches lessons off, adds
 * their own, and decides whether new projects are learned on their own.
 */
export function ProjectReviewSkillSettings() {
  const { target } = useSettingsScope();
  const configs = useServerConfigs();
  if (target === null || target === undefined || target.projectId === null) return null;
  if (configs.get(target.environmentId)?.environment.capabilities.reviewSkill !== true) return null;
  return <ReviewSkillSection environmentId={target.environmentId} projectId={target.projectId} />;
}

function ReviewSkillSection({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const status = useEnvironmentQuery(
    reviewEnvironment.skill({ environmentId, input: { projectId } }),
  );
  const settings = useEnvironmentSettings(environmentId);
  const learnSkill = useAtomCommand(reviewEnvironment.learnSkill, {
    label: "learn how this project is reviewed",
  });
  const editSkill = useAtomCommand(reviewEnvironment.editSkill, {
    label: "change the project's review skill",
  });
  const forgetSkill = useAtomCommand(reviewEnvironment.forgetSkill, {
    label: "forget the project's review skill",
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save review skill settings",
  });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const skill = status.data ?? null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    const operation = await settlePromise(async () => {
      await action();
      status.refresh();
    });
    setBusy(false);
    if (operation._tag === "Failure") throw squashAtomCommandFailure(operation);
  };
  const edit = (change: ReviewSkillEdit) =>
    run(() => editSkill({ environmentId, input: { projectId, edit: change } }));

  const summary =
    skill === null
      ? "Not learned yet. An agent reads how this project's pull requests were reviewed and what had to be fixed after merging."
      : skill.status === "learning"
        ? "Learning from this project's history now."
        : skill.learnedAt === null
          ? "Your own lessons. Nothing was learned from the project's history yet."
          : `Learned ${new Date(skill.learnedAt).toLocaleDateString()} · ${skill.lessons.length} ${skill.lessons.length === 1 ? "lesson" : "lessons"}`;
  const text = draft.trim();

  return (
    <SettingsSection title="Review skill">
      <SettingsRow
        title="What reviews of this project look for"
        description={summary}
        control={
          <div className="flex items-center gap-2">
            {skill?.learningThreadId ? (
              <Button
                size="sm"
                variant="ghost"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: skill.learningThreadId }}
                  />
                }
              >
                {skill.status === "learning" ? "Watch" : "How it was learned"}
              </Button>
            ) : null}
            {skill !== null ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => forgetSkill({ environmentId, input: { projectId } }))}
              >
                Forget
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || skill?.status === "learning"}
              onClick={() => void run(() => learnSkill({ environmentId, input: { projectId } }))}
            >
              {skill === null || skill.learnedAt === null ? "Learn now" : "Learn again"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 pt-3">
          {skill !== null && skill.summary.length > 0 ? (
            <p className="whitespace-pre-wrap text-muted-foreground text-xs">{skill.summary}</p>
          ) : null}
          {skill !== null && skill.lessons.length > 0 ? (
            <ReviewSkillLessonList
              lessons={skill.lessons}
              disabled={busy}
              onToggle={(lesson, enabled) =>
                void edit({ kind: "set-enabled", lessonId: lesson.id, enabled })
              }
              onRemove={(lesson) => void edit({ kind: "remove", lessonId: lesson.id })}
            />
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.length === 0) return;
              void edit({ kind: "add", text: text as never }).then(() => setDraft(""));
            }}
          >
            <Input
              aria-label="A lesson of your own"
              placeholder="Add a lesson of your own, for example: migrations must be reversible"
              maxLength={LESSON_MAX_CHARS}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || text.length === 0}>
              Add
            </Button>
          </form>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Learn new projects automatically"
        description="The first time a project is opened, an agent learns its review skill in the background. It runs on your plan, once per project."
        serverScoped
        control={
          <Switch
            aria-label="Learn new projects automatically"
            checked={settings.reviewSkillAutoLearn}
            onCheckedChange={(checked) =>
              void updateSettings({
                environmentId,
                input: { patch: { reviewSkillAutoLearn: checked } },
              })
            }
          />
        }
      />
    </SettingsSection>
  );
}
