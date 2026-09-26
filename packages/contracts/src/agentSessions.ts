import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/** Imported message ids retain their origin after event metadata is projected into SQLite. */
export function isImportedAgentSessionMessageId(messageId: string): boolean {
  return messageId.startsWith("import:");
}

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

/** One provider session, as named by the list RPC and the import selection. */
export const AgentSessionRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
});
export type AgentSessionRef = typeof AgentSessionRef.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  /**
   * Import only these sessions. Omitted imports every recent session the
   * scanner finds (the pre-selection behavior older clients rely on).
   */
  sessions: Schema.optional(Schema.Array(AgentSessionRef)),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

/**
 * Why a session is folded away by default: a Codex sub-agent rollout, a
 * session another agent started with an agent message, Codex internal work
 * (review, compaction), a fragment too short to be a conversation, or a
 * session whose user messages are only injected context.
 */
export const AgentSessionHiddenReason = Schema.Literals([
  "subagent",
  "agent-message",
  "internal",
  "too-short",
  "no-user-text",
  // A provider session ViewCode itself ran: importing it would duplicate a thread.
  "in-viewcode",
]);
export type AgentSessionHiddenReason = typeof AgentSessionHiddenReason.Type;

export const AgentSessionListInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

export const AgentSessionSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  provider: AgentSessionSource,
  title: TrimmedNonEmptyString,
  firstActivityAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  userMessageCount: NonNegativeInt,
  alreadyImported: Schema.Boolean,
  hidden: Schema.Boolean,
  hiddenReason: Schema.NullOr(AgentSessionHiddenReason),
});
export type AgentSessionSummary = typeof AgentSessionSummary.Type;

/** Recent sessions for a project, newest first. Nothing is imported by listing. */
export const AgentSessionListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionSummary),
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
