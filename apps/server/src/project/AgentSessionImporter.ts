import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ViewCodeImportedLineage from "./ViewCodeImportedLineage.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const linkImportedParents = yield* ViewCodeImportedLineage.make;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const selected =
      input.sessions === undefined
        ? null
        : new Set(
            input.sessions.map(
              (session) => `${session.providerInstanceId}\u0000${session.providerSessionId}`,
            ),
          );
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    const parentLinks: ViewCodeImportedLineage.ImportedParentLink[] = [];
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        if (outcome._tag === "Warning") {
          yield* Effect.logWarning(outcome.message);
          return;
        }
        const source = outcome.source;
        if (
          selected !== null &&
          !selected.has(`${source.providerInstanceId}\u0000${source.providerSessionId}`)
        )
          return;
        if (
          outcome._tag === "Importable" &&
          selected === null &&
          outcome.thread.hiddenReason === "internal"
        )
          return;
        const threadId = ViewCodeImportedLineage.importedThreadId(source);
        if (outcome._tag === "Importable" && outcome.thread.parentProviderSessionId !== undefined)
          parentLinks.push({
            childThreadId: threadId,
            parentThreadId: ViewCodeImportedLineage.importedThreadId({
              ...source,
              providerSessionId: outcome.thread.parentProviderSessionId,
            }),
          });
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const driver = thread.driver ?? ProviderDriverKind.make(thread.source);
          const resume =
            thread.resume ??
            (thread.source === "codex" || thread.source === "claudeAgent"
              ? { provider: thread.source, sessionId: thread.providerSessionId }
              : undefined);
          const nativeSessionId = resume?.sessionId ?? thread.providerSessionId;
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: nativeSessionId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: resume === undefined ? null : providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef:
              resume === undefined
                ? null
                : {
                    driver,
                    nativeId: nativeSessionId,
                    strength: "strong",
                  },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          yield* runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                resume === undefined
                  ? null
                  : resume.provider === "codex"
                    ? { threadId: resume.sessionId }
                    : {
                        threadId,
                        resume: resume.sessionId,
                        ...(resume.resumeSessionAt === undefined
                          ? {}
                          : { resumeSessionAt: resume.resumeSessionAt }),
                      },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    yield* linkImportedParents(input.projectId, parentLinks).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Imported conversation text, but could not restore every parent link", {
          cause,
        }),
      ),
    );
    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  const listImportableAgentSessions = Effect.fn("listImportableAgentSessionsV2")(function* (
    input: AgentSessionListInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    )
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const imported = new Set(
      runtimeRows.flatMap((row) => {
        const payload = decodeImportedTranscriptPayload(row.runtimePayload);
        return Option.isSome(payload) &&
          payload.value.cwd !== undefined &&
          normalizeProjectPathForComparison(payload.value.cwd) ===
            normalizeProjectPathForComparison(project.workspaceRoot)
          ? (payload.value.importedTranscripts ?? []).map(
              (source) =>
                `${source.provider}\u0000${source.providerInstanceId}\u0000${source.providerSessionId}`,
            )
          : [];
      }),
    );
    const owned = new Set(
      runtimeRows
        .filter((row) => !row.threadId.startsWith("import:"))
        .flatMap((row) => {
          const cursor = row.resumeCursor;
          if (typeof cursor !== "object" || cursor === null) return [];
          const record = cursor as Record<string, unknown>;
          const id = record.resume ?? record.sessionId ?? record.threadId;
          return typeof id === "string" ? [`${row.providerInstanceId}\u0000${id}`] : [];
        }),
    );
    const warnings = new Set<string>();
    const sessions: Array<AgentSessionListResult["sessions"][number]> = [];
    const inT3 = new Set<string>();
    const outcomes = yield* scanner.recentThreads(project.workspaceRoot).pipe(Stream.runCollect);
    for (const outcome of outcomes)
      if (
        outcome._tag === "Importable" &&
        outcome.thread.source === "t3code" &&
        outcome.thread.resume !== undefined
      )
        inT3.add(`${outcome.thread.providerInstanceId}\u0000${outcome.thread.resume.sessionId}`);
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome._tag === "Warning") {
        warnings.add(outcome.message);
        continue;
      }
      if (outcome._tag !== "Importable") continue;
      const thread = outcome.thread;
      const key = `${thread.source}\u0000${thread.providerInstanceId}\u0000${thread.providerSessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const providerKey = `${thread.providerInstanceId}\u0000${thread.providerSessionId}`;
      const hiddenReason = owned.has(providerKey)
        ? "in-viewcode"
        : thread.source !== "t3code" && inT3.has(providerKey)
          ? "in-t3code"
          : (thread.hiddenReason ?? null);
      sessions.push({
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: thread.providerSessionId,
        provider: thread.source,
        title: thread.title,
        firstActivityAt: thread.createdAt,
        lastActivityAt: thread.updatedAt,
        userMessageCount:
          thread.userMessageCount ?? thread.messages.filter((m) => m.role === "user").length,
        alreadyImported: imported.has(key),
        hidden: hiddenReason !== null,
        hiddenReason,
        ...(thread.model === null ? {} : { model: thread.model }),
      });
    }
    sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return {
      sessions,
      ...(warnings.size === 0 ? {} : { warning: [...warnings].join(" ") }),
    } satisfies AgentSessionListResult;
  });
  return { importRecentAgentThreads, listImportableAgentSessions };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
