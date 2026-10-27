import type { StaticScreenProps } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type AgentSessionListResult,
  type AgentSessionSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { T3Wordmark } from "../../components/T3Wordmark";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { connectionAtomRuntime } from "../../connection/runtime";
import { cn } from "../../lib/cn";
import { useProject, useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  HIDDEN_REASON_LABELS,
  importSelection,
  partitionImportableSessions,
  sessionKey,
  toggleSelectAll,
  type SelectAllState,
} from "./agentSessionImport";

const agentSessionList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:agent-sessions:list",
  tag: WS_METHODS.agentSessionsList,
});

const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

type ImportSessionsParams = {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function plural(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Pick past T3 Code, Claude Code, Codex and Cursor conversations to continue in one project,
 * through the same `agentSessions.list` / `agentSessions.import` RPCs as desktop. Opened from a
 * project's menu with its ref, or from Settings without one, which asks for the project first.
 */
export function ImportSessionsRouteScreen({
  route,
}: StaticScreenProps<ImportSessionsParams | undefined>) {
  const params = route.params ?? {};
  const routedProject = useProject(
    params.environmentId && params.projectId
      ? { environmentId: params.environmentId, projectId: params.projectId }
      : null,
  );
  const [pickedProject, setPickedProject] = useState<EnvironmentProject | null>(null);
  const project = routedProject ?? pickedProject;

  return (
    <SettingsScreen title="Import past sessions">
      {project ? (
        <ImportSessionsList
          key={`${project.environmentId}\0${project.id}`}
          project={project}
          onChangeProject={routedProject ? null : () => setPickedProject(null)}
        />
      ) : (
        <ProjectPicker onPick={setPickedProject} />
      )}
    </SettingsScreen>
  );
}

function ProjectPicker(props: { readonly onPick: (project: EnvironmentProject) => void }) {
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <Text className="px-1 text-sm leading-normal text-foreground-muted">
        Choose the project to bring past conversations into.
      </Text>
      {projects.length === 0 ? (
        <Text className="px-1 py-6 text-center text-sm text-foreground-muted">
          No projects on your connected environments.
        </Text>
      ) : (
        <View className="overflow-hidden rounded-[20px] bg-grouped-card">
          {projects.map((project, index) => (
            <Pressable
              key={`${project.environmentId}\0${project.id}`}
              accessibilityRole="button"
              accessibilityLabel={project.title}
              className={cn(
                "min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:bg-subtle",
                index > 0 && "border-t border-border-subtle",
              )}
              onPress={() => props.onPick(project)}
            >
              <ProjectFavicon
                environmentId={project.environmentId}
                faviconPath={project.faviconPath}
                projectIcon={project.projectIcon}
                size={18}
                projectTitle={project.title}
                workspaceRoot={project.workspaceRoot}
              />
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {project.title}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {project.workspaceRoot}
                </Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={12}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | ({ readonly status: "ready" } & AgentSessionListResult);

function ImportSessionsList(props: {
  readonly project: EnvironmentProject;
  readonly onChangeProject: (() => void) | null;
}) {
  const { project } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const listSessions = useAtomCommand(agentSessionList, { reportFailure: false });
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importedCount, setImportedCount] = useState<number | null>(null);
  // Only the latest listing may land, and none after the screen closes.
  const listRequestRef = useRef(0);

  const fetchSessions = useCallback(() => {
    const request = ++listRequestRef.current;
    void listSessions({
      environmentId: project.environmentId,
      input: { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
    }).then((result) => {
      if (request !== listRequestRef.current || isAtomCommandInterrupted(result)) return;
      setList(
        result._tag === "Success"
          ? { status: "ready", ...result.value }
          : { status: "error", message: errorMessage(squashAtomCommandFailure(result)) },
      );
    });
  }, [listSessions, project.environmentId, project.id, project.workspaceRoot]);

  useEffect(() => {
    fetchSessions();
    return () => {
      listRequestRef.current += 1;
    };
  }, [fetchSessions]);

  const reload = () => {
    setList({ status: "loading" });
    fetchSessions();
  };

  const { visible, hidden } = partitionImportableSessions(
    list.status === "ready" ? list.sessions : [],
  );
  const shown = showHidden ? [...visible, ...hidden] : visible;
  const { selected, state: selectAllState } = importSelection(shown, checked);
  const canSelectAny = shown.some((session) => !session.alreadyImported);

  const toggle = (session: AgentSessionSummary) => {
    const next = new Set(checked);
    const key = sessionKey(session);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  };

  const runImport = async () => {
    if (importing || selected.length === 0) return;
    setImporting(true);
    setImportError("");
    const result = await importSessions({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        expectedWorkspaceRoot: project.workspaceRoot,
        sessions: selected.map(({ providerInstanceId, providerSessionId }) => ({
          providerInstanceId,
          providerSessionId,
        })),
      },
    });
    setImporting(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        setImportError(errorMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    const { importedCount: count, skippedCount } = result.value;
    setChecked(new Set());
    if (skippedCount > 0) {
      setImportError(
        `Imported ${plural(count, "session")}. ${plural(skippedCount, "session")} could not be imported.`,
      );
      reload();
      return;
    }
    setImportedCount(count);
  };

  if (importedCount !== null) {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-8">
        <SymbolView
          name="checkmark.circle"
          size={44}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <Text className="text-center text-lg font-t3-bold text-foreground">
          Imported {plural(importedCount, "session")}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          They are threads in {project.title} now.
        </Text>
        <ConnectionSheetButton
          icon="checkmark"
          label="Done"
          tone="primary"
          onPress={() => navigation.goBack()}
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <View className="flex-row items-center gap-3 px-1">
          <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-muted">
            T3 Code conversations, and Claude Code, Codex and Cursor ones from the last 60 days, to
            continue in <Text className="font-t3-medium text-foreground">{project.title}</Text>.
          </Text>
          {props.onChangeProject ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={props.onChangeProject}>
              <Text className="text-sm font-t3-medium text-primary-text">Change</Text>
            </Pressable>
          ) : null}
        </View>

        {list.status === "loading" ? (
          <View className="flex-row items-center justify-center gap-2 py-10">
            <AppActivityIndicator />
            <Text className="text-sm text-foreground-muted">Reading past sessions…</Text>
          </View>
        ) : list.status === "error" ? (
          <View className="gap-3">
            <ErrorBanner message={`Could not read sessions. ${list.message}`} />
            <ConnectionSheetButton
              compact
              icon="arrow.clockwise"
              label="Retry"
              tone="secondary"
              onPress={reload}
            />
          </View>
        ) : list.sessions.length === 0 ? (
          <Text className="px-1 py-10 text-center text-sm leading-normal text-foreground-muted">
            {list.warning ??
              "No T3 Code conversations, or Claude Code, Codex or Cursor sessions from the last 60 days, in this folder."}
          </Text>
        ) : (
          <>
            {list.warning ? (
              <Text className="px-1 text-xs text-foreground-muted">{list.warning}</Text>
            ) : null}
            {shown.length === 0 ? (
              <Text className="px-1 py-4 text-center text-sm leading-normal text-foreground-muted">
                Nothing new to import. The hidden ones are already in ViewCode, sub-agents or too
                short; show hidden to see them.
              </Text>
            ) : (
              <View className="overflow-hidden rounded-[20px] bg-grouped-card">
                {canSelectAny ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel="Select all"
                    accessibilityState={{
                      checked: selectAllState === "some" ? "mixed" : selectAllState === "all",
                      disabled: importing,
                    }}
                    disabled={importing}
                    className="min-h-[48px] flex-row items-center gap-3 border-b border-border-subtle px-4 py-2.5 active:bg-subtle"
                    onPress={() => setChecked(toggleSelectAll(shown, checked))}
                  >
                    <CheckboxMark state={selectAllState} />
                    <Text className="text-sm font-t3-medium text-foreground">Select all</Text>
                  </Pressable>
                ) : null}
                {shown.map((session, index) => (
                  <SessionRow
                    key={sessionKey(session)}
                    session={session}
                    first={index === 0 && !canSelectAny}
                    checked={session.alreadyImported || checked.has(sessionKey(session))}
                    disabled={importing || session.alreadyImported}
                    onPress={() => toggle(session)}
                  />
                ))}
              </View>
            )}
            {hidden.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                className="self-start px-1 py-2"
                hitSlop={6}
                onPress={() => setShowHidden((value) => !value)}
              >
                <Text className="text-sm font-t3-medium text-primary-text">
                  {showHidden ? "Hide" : "Show"} hidden ({hidden.length})
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>

      <View
        className="gap-3 border-t border-border-subtle bg-sheet px-5 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) + 6 }}
      >
        {importError ? <ErrorBanner message={importError} /> : null}
        <ConnectionSheetButton
          fullWidth
          icon="tray.and.arrow.down"
          label={
            importing
              ? "Importing…"
              : selected.length === 0
                ? "Import"
                : `Import ${plural(selected.length, "session")}`
          }
          disabled={importing || selected.length === 0}
          tone="primary"
          onPress={() => void runImport()}
        />
      </View>
    </View>
  );
}

function CheckboxMark(props: { readonly state: SelectAllState }) {
  return (
    <View
      className={cn(
        "size-5 items-center justify-center rounded-[6px]",
        props.state === "none" ? "border-[1.5px] border-input-border" : "bg-primary",
      )}
    >
      {props.state === "none" ? null : (
        <SymbolView
          name={props.state === "all" ? "checkmark" : "minus"}
          size={12}
          tintColorClassName="accent-primary-foreground"
          type="monochrome"
        />
      )}
    </View>
  );
}

function SourceIcon(props: { readonly provider: AgentSessionSummary["provider"] }) {
  // T3 Code has no provider icon of its own; desktop shows the app mark there too.
  return props.provider === "t3code" ? (
    <T3Wordmark height={16} />
  ) : (
    <ProviderIcon provider={props.provider} size={16} />
  );
}

const SOURCE_LABELS: Record<AgentSessionSummary["provider"], string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  t3code: "T3 Code",
};

function SessionRow(props: {
  readonly session: AgentSessionSummary;
  readonly first: boolean;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { session } = props;
  const badge = session.alreadyImported
    ? "Imported"
    : session.hiddenReason !== null
      ? HIDDEN_REASON_LABELS[session.hiddenReason]
      : null;
  const date = formatSessionDate(session.lastActivityAt);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={`${SOURCE_LABELS[session.provider]}: ${session.title}`}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      className={cn(
        "min-h-[56px] flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle",
        !props.first && "border-t border-border-subtle",
        session.alreadyImported && "opacity-60",
      )}
      onPress={props.onPress}
    >
      <CheckboxMark state={props.checked ? "all" : "none"} />
      <SourceIcon provider={session.provider} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm text-foreground" numberOfLines={2}>
          {session.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {[
            date,
            plural(session.userMessageCount, "message"),
            badge,
            session.provider === "t3code" ? session.model : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}
