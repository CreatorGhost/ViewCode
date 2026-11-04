import { COMMAND_CODE_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
export interface CommandCodeTurnArgsInput {
  /** Native session to continue; omitted on a thread's first turn. */
  readonly resumeSessionId?: string | undefined;
  readonly model?: string | undefined;
  /** Full access lifts the print-mode write/shell gate with `--yolo`. */
  readonly fullAccess: boolean;
  readonly addDirs?: ReadonlyArray<string>;
}

/** Argv for one headless turn. The prompt itself is written to stdin. */
export function buildCommandCodeTurnArgs(input: CommandCodeTurnArgsInput): Array<string> {
  const model = input.model?.trim();
  return [
    "-p",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--no-auto-update",
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(model && model !== COMMAND_CODE_DEFAULT_MODEL ? ["--model", model] : []),
    ...(input.fullAccess ? ["--yolo"] : []),
    ...(input.addDirs ?? []).flatMap((directory) => ["--add-dir", directory]),
  ];
}

/** `cmd` is also Windows' shell, so Windows spawns the package's `command-code` bin instead. */
export function resolveCommandCodeBinary(binaryPath: string, platform: NodeJS.Platform): string {
  const configured = binaryPath.trim() || "cmd";
  return platform === "win32" && configured.toLowerCase() === "cmd" ? "command-code" : configured;
}

function nonEmpty(value: string | undefined) {
  return value?.trim() || undefined;
}
export interface CommandCodeListedModel {
  readonly slug: string;
  readonly description: string | undefined;
  readonly group: string | undefined;
  readonly isCliDefault: boolean;
}

/**
 * Parses `cmd --list-models`: group headings, then `<id>  <description>`
 * rows. Parsing stops at the usage footer so the headless-only decision
 * models after it are never offered as chat models.
 */
export function parseCommandCodeModelList(output: string): ReadonlyArray<CommandCodeListedModel> {
  const models: Array<CommandCodeListedModel> = [];
  const seen = new Set<string>();
  let group: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^(Pass the full id|Docs:|Decision models)/.test(line.trim())) break;
    if (/^Available models\b/.test(line.trim())) continue;
    const row = /^(\S+)\s{2,}(.*)$/.exec(line.trim());
    if (!row) {
      group = line.trim();
      continue;
    }
    const slug = row[1]!;
    if (slug === "cmd" || seen.has(slug)) continue;
    seen.add(slug);
    const rawDescription = row[2]!.trim();
    const isCliDefault = /\(default\)\s*$/.test(rawDescription);
    const description = nonEmpty(rawDescription.replace(/\s*\(default\)\s*$/, ""));
    models.push({ slug, description, group, isCliDefault });
  }
  return models;
}

export function commandCodeModelsFromList(
  listed: ReadonlyArray<CommandCodeListedModel>,
): ReadonlyArray<ServerProviderModel> {
  const cliDefault = listed.find((model) => model.isCliDefault)?.slug;
  return [
    {
      slug: COMMAND_CODE_DEFAULT_MODEL,
      name: cliDefault ? `Default (${cliDefault})` : "Default",
      shortName: cliDefault ? `Default · ${cliDefault.split("/").at(-1)}` : "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    ...listed.map((model): ServerProviderModel => {
      const shortName = model.slug.includes("/") ? model.slug.split("/").at(-1) : undefined;
      return {
        slug: model.slug,
        name: model.slug,
        ...(shortName ? { shortName } : {}),
        ...(model.group ? { subProvider: model.group } : {}),
        isCustom: false,
        capabilities: null,
      };
    }),
  ];
}

const StatusJson = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
});
const decodeStatusJson = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

/** Reads `cmd status --json`. It exits 1 when signed out, so the exit code is not the verdict. */
export function parseCommandCodeStatus(
  output: string,
): { readonly authenticated: boolean; readonly version: string | undefined } | undefined {
  for (const line of output.split(/\r?\n/)) {
    const decoded = decodeStatusJson(line.trim());
    if (Option.isSome(decoded)) {
      return { authenticated: decoded.value.authenticated, version: decoded.value.version };
    }
  }
  return undefined;
}

export function commandCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const decodeFrame = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function parseCommandCodeFrame(line: string) {
  try {
    const frame = commandCodeRecord(decodeFrame(line));
    if (frame?.type === "result") return frame;
    return frame?.type === "event" ? commandCodeRecord(frame.event) : undefined;
  } catch {
    return undefined;
  }
}

export interface CommandCodeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export function parseCommandCodeUsage(value: unknown): CommandCodeUsage | undefined {
  const raw = commandCodeRecord(value);
  if (!raw) return undefined;
  const count = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? Math.max(0, Math.floor(raw[key]))
      : 0;
  return {
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
  };
}

export function commandCodeOutputText(value: unknown): string {
  return typeof value === "string" ? value : encodeFrame(value);
}
