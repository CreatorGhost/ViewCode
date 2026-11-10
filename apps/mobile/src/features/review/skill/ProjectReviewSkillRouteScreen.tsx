import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  REVIEW_SKILL_MAX_LESSON_CHARS,
  type ReviewSkill,
  type ReviewSkillEdit,
  type ReviewSkillLesson,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { showConfirmDialog } from "../../../components/ConfirmDialogHost";
import { ControlPill } from "../../../components/ControlPill";
import { EmptyState } from "../../../components/EmptyState";
import { ScreenScrollView as ScrollView } from "../../../components/ScreenScrollView";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { relativeTime } from "../../../lib/time";
import { useEnvironmentServerConfig, useProject } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewEnvironment } from "../../../state/review";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsScreen } from "../../settings/components/SettingsScreen";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";

type ProjectReviewSkillParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

/** The server tells nobody when learning ends, so the screen asks while it shows "Learning". */
const LEARNING_REFRESH_MS = 10_000;

const SOURCE_LABELS: Record<ReviewSkillLesson["source"], string> = {
  "kept-breaking": "kept breaking",
  "reviewers-ask": "reviewers ask",
  yours: "yours",
};

function lessonStanding(lesson: ReviewSkillLesson): string {
  if (lesson.disabledByRatings) return "off after your ratings";
  if (lesson.helpful === 0 && lesson.unhelpful === 0) return "not rated yet";
  return `${lesson.helpful} helpful, ${lesson.unhelpful} not`;
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * A project's review skill: what its own history taught a reviewer, which every review of the
 * project reads. Learned by an agent thread on the server and kept there per user, so this
 * screen only shows it, switches lessons, adds the reader's own, and starts or forgets learning.
 */
export function ProjectReviewSkillRouteScreen({
  route,
}: StaticScreenProps<ProjectReviewSkillParams>) {
  const { environmentId, projectId } = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const project = useProject({ environmentId, projectId });
  const supported = serverConfig?.environment.capabilities.reviewSkill === true;
  const query = useEnvironmentQuery(
    supported ? reviewEnvironment.skill({ environmentId, input: { projectId } }) : null,
  );
  const { refresh } = query;
  const skill = query.data;
  const learning = skill?.status === "learning";

  // Lessons may have been switched off from a finding, or learning may have ended, meanwhile.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  useEffect(() => {
    if (!learning) return;
    const id = setInterval(refresh, LEARNING_REFRESH_MS);
    return () => clearInterval(id);
  }, [learning, refresh]);

  const learnSkill = useAtomCommand(reviewEnvironment.learnSkill, { reportFailure: false });
  const editSkill = useAtomCommand(reviewEnvironment.editSkill, { reportFailure: false });
  const forgetSkill = useAtomCommand(reviewEnvironment.forgetSkill, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "review skill auto-learn update",
    reportFailure: true,
  });
  const [busy, setBusy] = useState(false);

  /** Runs one change, says so when it fails, and reads the skill again either way. */
  const mutate = async <A, E>(title: string, run: () => Promise<AtomCommandResult<A, E>>) => {
    setBusy(true);
    const result = await run();
    setBusy(false);
    refresh();
    if (result._tag !== "Failure") return true;
    if (!isAtomCommandInterrupted(result)) {
      Alert.alert(title, failureMessage(squashAtomCommandFailure(result), "The request failed."));
    }
    return false;
  };
  const edit = (title: string, change: ReviewSkillEdit) =>
    mutate(title, () => editSkill({ environmentId, input: { projectId, edit: change } }));
  const learn = () =>
    void mutate("Could not start learning", () =>
      learnSkill({ environmentId, input: { projectId } }),
    );
  const forget = () => {
    const title = "Forget this project's review skill?";
    const message =
      "Its lessons, yours included, are deleted. Reviews of this project stop reading them.";
    const onConfirm = () =>
      void mutate("Could not forget the review skill", () =>
        forgetSkill({ environmentId, input: { projectId } }),
      );
    if (Platform.OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: onConfirm },
      ]);
      return;
    }
    showConfirmDialog({ title, message, confirmText: "Forget", destructive: true, onConfirm });
  };

  const autoLearn = serverConfig?.settings.reviewSkillAutoLearn ?? true;

  return (
    <SettingsScreen title="Review skill">
      {!supported ? (
        <View className="flex-1 items-center justify-center">
          <EmptyState
            variant="plain"
            title="Not available"
            detail="This environment's server does not learn review skills. Update it to use them."
          />
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {project !== null ? (
            <Text className="px-2 text-xl font-t3-semibold text-foreground" numberOfLines={2}>
              {project.title}
            </Text>
          ) : null}

          <SettingsSection title="Learning">
            <View className="gap-3 p-4">
              <SkillStatus
                skill={skill}
                loading={query.isPending && skill === null}
                error={query.error}
              />
              <View className="flex-row flex-wrap gap-2">
                {skill?.learningThreadId != null ? (
                  <ControlPill
                    variant="pill"
                    label="Open learning thread"
                    onPress={() => {
                      const threadId = skill.learningThreadId;
                      if (threadId === null) return;
                      navigation.navigate("Thread", { environmentId, threadId });
                    }}
                  />
                ) : null}
                <ControlPill
                  variant="pill"
                  label={skill === null ? "Learn now" : "Learn again"}
                  disabled={busy || learning}
                  onPress={learn}
                />
                {skill !== null ? (
                  <ControlPill variant="pill" label="Forget" disabled={busy} onPress={forget} />
                ) : null}
              </View>
            </View>
            <View className="border-t border-border-subtle">
              <SettingsSwitchRow
                icon="sparkles"
                label="Learn new projects automatically"
                subtitle="An agent reads a project's history on your plan the first time you open it. Applies to every project on this environment."
                value={autoLearn}
                onValueChange={(value) =>
                  void updateSettings({
                    environmentId,
                    input: { patch: { reviewSkillAutoLearn: value } },
                  })
                }
              />
            </View>
          </SettingsSection>

          {skill !== null && skill.summary.trim().length > 0 ? (
            <SettingsSection title="How this project is reviewed">
              <Text selectable className="p-4 text-[15px] leading-[21px] text-foreground">
                {skill.summary}
              </Text>
            </SettingsSection>
          ) : null}

          <SettingsSection title="Lessons">
            {skill === null || skill.lessons.length === 0 ? (
              <Text className="p-4 text-[15px] text-foreground-muted">
                No lessons yet. Reviews are told about each lesson that is switched on.
              </Text>
            ) : (
              skill.lessons.map((lesson, index) => (
                <LessonRow
                  key={lesson.id}
                  lesson={lesson}
                  first={index === 0}
                  disabled={busy}
                  onToggle={(enabled) =>
                    void edit("Could not update the lesson", {
                      kind: "set-enabled",
                      lessonId: lesson.id,
                      enabled,
                    })
                  }
                  onRemove={() =>
                    void edit("Could not remove the lesson", {
                      kind: "remove",
                      lessonId: lesson.id,
                    })
                  }
                />
              ))
            )}
          </SettingsSection>

          <AddLesson
            disabled={busy}
            onAdd={(text, where) =>
              edit("Could not add the lesson", {
                kind: "add",
                text,
                ...(where.length > 0 ? { where } : {}),
              })
            }
          />
        </ScrollView>
      )}
    </SettingsScreen>
  );
}

function SkillStatus(props: {
  readonly skill: ReviewSkill | null;
  readonly loading: boolean;
  readonly error: string | null;
}) {
  const { skill } = props;
  if (props.loading) return <ActivityIndicator colorClassName="accent-icon-muted" />;
  if (props.error !== null && skill === null) {
    return <Text className="text-[15px] text-danger-foreground">{props.error}</Text>;
  }
  if (skill?.status === "learning") {
    return (
      <View className="flex-row items-center gap-3">
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] text-foreground">Learning now</Text>
          <Text className="text-[13px] text-foreground-muted">
            {skill.learnedAt === null
              ? "An agent is reading this project's history."
              : `The lessons below are from ${relativeTime(skill.learnedAt)} ago until it finishes.`}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View className="gap-0.5">
      <Text className="text-[15px] text-foreground">
        {skill === null || skill.learnedAt === null
          ? "Not learned yet"
          : `Learned ${new Date(skill.learnedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}`}
      </Text>
      <Text className="text-[13px] text-foreground-muted">
        Learns from how this project's pull requests were reviewed and what had to be fixed after
        merging. Kept on this environment for you, not in the repository.
      </Text>
    </View>
  );
}

function LessonRow(props: {
  readonly lesson: ReviewSkillLesson;
  readonly first: boolean;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const { lesson } = props;
  return (
    <View
      className={cn(
        "flex-row items-start gap-3 p-4",
        !props.first && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-1.5">
        <Text
          selectable
          className={cn(
            "text-[15px] leading-[20px]",
            lesson.enabled ? "font-t3-medium text-foreground" : "text-foreground-muted",
          )}
        >
          {lesson.text}
        </Text>
        {lesson.where !== undefined ? (
          <Text selectable className="font-mono text-[12px] text-foreground-muted">
            {lesson.where}
          </Text>
        ) : null}
        <Text className="text-[13px] text-foreground-muted">
          <Text
            className={cn(
              "text-[13px] font-t3-medium",
              lesson.source === "kept-breaking"
                ? "text-adaptive-amber-700-300"
                : "text-foreground-muted",
            )}
          >
            {SOURCE_LABELS[lesson.source]}
          </Text>
          {lesson.occurrences !== undefined ? ` · ${lesson.occurrences}×` : ""}
          {` · ${lessonStanding(lesson)}`}
        </Text>
        {lesson.evidence.length > 0 || lesson.source === "yours" ? (
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            {lesson.evidence.map((evidence) => (
              <Pressable
                key={evidence.url}
                accessibilityRole="link"
                accessibilityLabel={`Open ${evidence.label}`}
                hitSlop={8}
                onPress={() =>
                  void tryOpenExternalUrl(evidence.url, "markdown-link").then((opened) => {
                    if (!opened) {
                      Alert.alert("Unable to open link", "The link could not be opened.");
                    }
                  })
                }
                className="active:opacity-70"
              >
                <Text className="text-[13px] text-foreground-muted underline">
                  {evidence.label}
                </Text>
              </Pressable>
            ))}
            {lesson.source === "yours" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove "${lesson.text}"`}
                hitSlop={8}
                disabled={props.disabled}
                onPress={props.onRemove}
                className="active:opacity-70"
              >
                <Text className="text-[13px] font-t3-medium text-danger-foreground">Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={`Use "${lesson.text}"`}
        disabled={props.disabled}
        value={lesson.enabled}
        onValueChange={props.onToggle}
      />
    </View>
  );
}

function AddLesson(props: {
  readonly disabled: boolean;
  /** Resolves to whether the lesson was added, which clears the form. */
  readonly onAdd: (text: string, where: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [where, setWhere] = useState("");
  const trimmed = text.trim();
  const add = () => {
    if (trimmed.length === 0 || props.disabled) return;
    void props.onAdd(trimmed, where.trim()).then((added) => {
      if (!added) return;
      setText("");
      setWhere("");
    });
  };
  return (
    <SettingsSection title="Add a lesson">
      <View className="gap-3 p-4">
        <AppTextInput
          accessibilityLabel="Lesson"
          placeholder="What reviews of this project should look for"
          value={text}
          onChangeText={setText}
          maxLength={REVIEW_SKILL_MAX_LESSON_CHARS}
          multiline
          editable={!props.disabled}
        />
        <AppTextInput
          accessibilityLabel="Where it applies"
          placeholder="Where it applies, e.g. apps/server/** (optional)"
          value={where}
          onChangeText={setWhere}
          maxLength={REVIEW_SKILL_MAX_LESSON_CHARS}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.disabled}
          onSubmitEditing={add}
          returnKeyType="done"
        />
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label="Add lesson"
            disabled={props.disabled || trimmed.length === 0}
            onPress={add}
          />
        </View>
      </View>
    </SettingsSection>
  );
}
