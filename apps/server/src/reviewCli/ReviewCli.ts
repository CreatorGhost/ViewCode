// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - a plain-Node CLI that must start fast; it never loads the server bundle or Effect.
/**
 * `viewcode-review`: hands ViewCode a review's findings from the reviewer's
 * shell, for sessions that cannot load ViewCode's MCP server (an organization
 * blocking MCP). `submit` reads the `submit_review_findings` input as JSON
 * from stdin or `--file`, POSTs it to the server named by
 * `VIEWCODE_REVIEW_ENDPOINT`, and prints the reply as one JSON line (exit 0
 * iff `ok`).
 *
 * The server validates the findings with the MCP tool's own schema, so this
 * only checks that the input is one JSON object.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import {
  REVIEW_AUTH_ENV,
  REVIEW_CLI_ROUTE_PATH,
  REVIEW_ENDPOINT_ENV,
  type ReviewCliError,
} from "./reviewCliProtocol.ts";

export type ParsedReviewArgs =
  | { readonly type: "help" }
  | { readonly type: "submit"; readonly body: string }
  | { readonly type: "error"; readonly error: ReviewCliError };

const usage = (message: string): ParsedReviewArgs => ({
  type: "error",
  error: { code: "usage", message: `${message} Run \`viewcode-review help\` for the manual.` },
});

const readSource = async (
  file: string | undefined,
  readStdin: () => Promise<string>,
): Promise<{ readonly text: string } | { readonly error: string }> => {
  if (file === undefined || file === "-") {
    try {
      return { text: await readStdin() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not read stdin." };
    }
  }
  try {
    return { text: await NodeFS.promises.readFile(file, "utf8") };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { error: `Could not read ${file}${typeof code === "string" ? ` (${code})` : ""}.` };
  }
};

/** Parses argv (without the program name) and reads the findings it names. */
export const parseReviewArgs = async (
  argv: ReadonlyArray<string>,
  readStdin: () => Promise<string>,
): Promise<ParsedReviewArgs> => {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { type: "help" };
  }
  if (name !== "submit") return usage(`Unknown command "${name}".`);
  let file: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index]!;
    if (raw !== "--file") {
      return usage(
        raw.startsWith("--") ? `"submit" does not take ${raw}.` : `Unexpected argument "${raw}".`,
      );
    }
    if (file !== undefined) return usage("--file was given twice.");
    const value = rest[index + 1];
    if (value === undefined) return usage("--file needs a path, or - for stdin.");
    file = value;
    index += 1;
  }
  const source = await readSource(file, readStdin);
  if ("error" in source) return usage(source.error);
  if (source.text.trim() === "") {
    return usage("No findings were given. Pipe the findings JSON to stdin or pass --file PATH.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source.text);
  } catch (error) {
    return usage(
      `The findings are not valid JSON: ${error instanceof Error ? error.message : "parse error"}.`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return usage("The findings must be one JSON object, not an array or a value.");
  }
  return { type: "submit", body: JSON.stringify(value) };
};

type Endpoint =
  | { readonly socketPath: string }
  | { readonly hostname: string; readonly port: number; readonly path: string };

export const parseReviewEndpoint = (raw: string): Endpoint | undefined => {
  if (raw.startsWith("unix:")) {
    const socketPath = raw.slice("unix:".length);
    return socketPath.length > 0 ? { socketPath } : undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 80,
    path: `${url.pathname}${url.search}`,
  };
};

type PostOutcome =
  | { readonly type: "response"; readonly status: number; readonly body: string }
  | { readonly type: "unreachable" };

const post = (endpoint: Endpoint, auth: string, body: string): Promise<PostOutcome> =>
  new Promise((resolve) => {
    const request = NodeHttp.request(
      {
        method: "POST",
        ...("socketPath" in endpoint
          ? { socketPath: endpoint.socketPath, path: REVIEW_CLI_ROUTE_PATH }
          : { hostname: endpoint.hostname, port: endpoint.port, path: endpoint.path }),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: auth,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            type: "response",
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", () => resolve({ type: "unreachable" }));
      },
    );
    request.on("error", () => resolve({ type: "unreachable" }));
    request.end(body);
  });

const isReviewCliResponse = (value: unknown): value is { ok: boolean } => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return "result" in record;
  if (record.ok !== false || typeof record.error !== "object" || record.error === null) {
    return false;
  }
  const error = record.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
};

export interface ReviewCliIo {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly readStdin: () => Promise<string>;
  readonly writeStdout: (text: string) => void;
}

/** Runs one CLI invocation and returns its exit code. */
export const runReviewCli = async (io: ReviewCliIo): Promise<number> => {
  const fail = (error: ReviewCliError) => {
    io.writeStdout(`${JSON.stringify({ ok: false, error })}\n`);
    return 1;
  };
  const rawEndpoint = io.env[REVIEW_ENDPOINT_ENV];
  const auth = io.env[REVIEW_AUTH_ENV];
  const parsed = await parseReviewArgs(io.argv, io.readStdin);
  if (parsed.type === "help") {
    io.writeStdout(REVIEW_CLI_MANUAL);
    return 0;
  }
  if (parsed.type === "error") return fail(parsed.error);

  if (!rawEndpoint || !auth) {
    return fail({
      code: "unavailable",
      message:
        "viewcode-review only works inside a ViewCode review session. Your written report is enough.",
    });
  }
  const endpoint = parseReviewEndpoint(rawEndpoint);
  if (!endpoint) {
    return fail({
      code: "unavailable",
      message: `${REVIEW_ENDPOINT_ENV} is not a valid endpoint.`,
    });
  }
  const outcome = await post(endpoint, auth, parsed.body);
  if (outcome.type === "unreachable") {
    return fail({
      code: "unreachable",
      message:
        "Could not reach the ViewCode server. If your shell is sandboxed, ask the user to switch this thread to full access; your written report is still the review.",
    });
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return fail({
      code: "credential",
      message:
        "The ViewCode server rejected this session's credential. Ask the user to restart the agent session.",
    });
  }
  if (outcome.status === 404) {
    return fail({
      code: "unreachable",
      message:
        "The ViewCode server at this session's endpoint has no review route; it probably restarted on another address or is older. Ask the user to restart the agent session.",
    });
  }
  let response: unknown;
  try {
    response = JSON.parse(outcome.body);
  } catch {
    response = undefined;
  }
  if (!isReviewCliResponse(response)) {
    return fail({ code: "invalid-reply", message: "The ViewCode server sent an invalid reply." });
  }
  io.writeStdout(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 1;
};

const readAllStdin = async (): Promise<string> => {
  // A terminal never ends, so waiting on it would hang the agent's shell.
  if (process.stdin.isTTY) {
    throw new Error("Nothing was piped to stdin. Pipe the findings JSON in or pass --file PATH.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Entry point shared by the standalone script and the executable's subcommand. */
export const runReviewCliMain = (argv: ReadonlyArray<string>): Promise<number> =>
  runReviewCli({
    argv,
    env: process.env,
    readStdin: readAllStdin,
    writeStdout: (text) => process.stdout.write(text),
  });

export const REVIEW_CLI_MANUAL = `viewcode-review: hand ViewCode your review's findings from your shell, for
when ViewCode's submit_review_findings tool is not in your tool list. The user
sees them in their Review panel.

USAGE
  viewcode-review submit < findings.json
  viewcode-review submit --file findings.json

The JSON is exactly submit_review_findings's input:
  {
    "verdict": "approve" | "approve-with-nits" | "request-changes",
    "mergeConfidence": 0-5,
    "reviewEffort": 1-5,
    "findings": [
      {
        "severity": "blocker" | "important" | "nit" | "question",
        "confidence": 0-100,
        "path": "src/a.ts",
        "line": 12, "endLine": 14,          (optional)
        "title": "Short title",
        "detail": "What is wrong, why it matters, how it is reached.",
        "suggestedFix": "code as it applies", (optional)
        "rule": "the repository rule broken", (optional)
        "preExisting": true                  (optional)
      }
    ],
    "needsChecking": [ same shape as findings ],
    "complete": false,                       (optional: while still reviewing)
    "target": "pull-request" | "local",      (optional)
    "mode": "fix" | "comment",               (optional: only when the request names one)
    "previous": { "fixed": 2, "stillOpen": 1 } (optional: re-reviews only)
  }

Each call replaces the set recorded before it, so always send the whole set so
far. Write the JSON to a file outside the repository (or pipe it) so the
user's working tree stays untouched.

It prints one JSON line: {"ok":true,"result":…} (exit 0) or
{"ok":false,"error":{"code":…,"message":…}} (exit 1). Read the message: it
says what to fix.

ERRORS
  usage            fix the JSON or the command line; the message names each
                   field that is wrong.
  unavailable      not in a ViewCode session: your written report is enough.
  unreachable      the server could not be reached; if your shell is sandboxed,
                   ask the user to switch this thread to full access.
  credential       ask the user to restart the agent session.
  Review…Error     from ViewCode itself (for example no linked pull request);
                   its message says what to change.
`;
