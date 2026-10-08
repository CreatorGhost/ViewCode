// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - a plain-Node CLI that must start fast; it never loads the server bundle or Effect.
/**
 * `viewcode-browser`: the collaborative browser from an agent's shell, for
 * sessions that cannot load ViewCode's MCP server (an organization blocking
 * MCP, or the tools turned off). It turns argv into one `preview_*` tool call,
 * POSTs it to the server named by `VIEWCODE_BROWSER_ENDPOINT`, and prints the
 * reply as one JSON line (exit 0 iff `ok`).
 *
 * Flags map one to one onto the MCP tool inputs. The server validates them
 * with the same schemas and runs the same handlers, so this parser only
 * shapes the input and catches typos.
 */
import * as NodeHttp from "node:http";

import {
  BROWSER_AUTH_ENV,
  BROWSER_CLI_ROUTE_PATH,
  BROWSER_ENDPOINT_ENV,
  type BrowserCliError,
  type BrowserCliRequest,
  type BrowserCliTool,
} from "./browserCliProtocol.ts";

type FlagKind = "string" | "number" | "boolean" | "text";

/** `text` flags accept `-` to read stdin. */
const FLAG_KINDS: Record<string, FlagKind> = {
  tab: "string",
  url: "string",
  port: "number",
  path: "string",
  https: "boolean",
  wait: "string",
  timeout: "number",
  background: "boolean",
  "new-tab": "boolean",
  "no-image": "boolean",
  locator: "string",
  selector: "string",
  x: "number",
  y: "number",
  text: "text",
  clear: "boolean",
  key: "string",
  modifiers: "string",
  dx: "number",
  dy: "number",
  expression: "text",
  "no-await": "boolean",
  "url-includes": "string",
  mode: "string",
  width: "number",
  height: "number",
  preset: "string",
  orientation: "string",
  scheme: "string",
};

type Flags = Readonly<Record<string, string | number | boolean>>;

interface Command {
  readonly tool: BrowserCliTool;
  readonly flags: ReadonlyArray<string>;
  readonly input: (flags: Flags) => Record<string, unknown>;
}

/** Drops undefined values so the server sees only what the agent passed. */
const defined = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

const tab = (flags: Flags) => ({ tabId: flags.tab });
const target = (flags: Flags) => ({ locator: flags.locator, selector: flags.selector });

const COMMANDS: Record<string, Command> = {
  status: { tool: "preview_status", flags: ["tab"], input: tab },
  open: {
    tool: "preview_open",
    flags: ["tab", "url", "background", "new-tab"],
    input: (flags) => ({
      ...tab(flags),
      url: flags.url,
      open: flags.background === true ? false : undefined,
      reuseExistingTab: flags["new-tab"] === true ? false : undefined,
    }),
  },
  navigate: {
    tool: "preview_navigate",
    flags: ["tab", "url", "port", "path", "https", "wait", "timeout"],
    input: (flags) => ({
      ...tab(flags),
      url: flags.url,
      target:
        flags.port === undefined
          ? undefined
          : defined({
              kind: "environment-port",
              port: flags.port,
              protocol: flags.https === true ? "https" : undefined,
              path: flags.path,
            }),
      readiness: flags.wait,
      timeoutMs: flags.timeout,
    }),
  },
  snapshot: {
    tool: "preview_snapshot",
    flags: ["tab", "no-image"],
    input: (flags) => ({
      ...tab(flags),
      includeImage: flags["no-image"] === true ? false : undefined,
    }),
  },
  click: {
    tool: "preview_click",
    flags: ["tab", "locator", "selector", "x", "y", "timeout"],
    input: (flags) => ({
      ...tab(flags),
      ...target(flags),
      x: flags.x,
      y: flags.y,
      timeoutMs: flags.timeout,
    }),
  },
  type: {
    tool: "preview_type",
    flags: ["tab", "locator", "selector", "text", "clear", "timeout"],
    input: (flags) => ({
      ...tab(flags),
      ...target(flags),
      text: flags.text,
      clear: flags.clear,
      timeoutMs: flags.timeout,
    }),
  },
  press: {
    tool: "preview_press",
    flags: ["tab", "key", "modifiers"],
    input: (flags) => ({
      ...tab(flags),
      key: flags.key,
      modifiers:
        typeof flags.modifiers === "string"
          ? flags.modifiers.split(",").map((modifier) => modifier.trim())
          : undefined,
    }),
  },
  scroll: {
    tool: "preview_scroll",
    flags: ["tab", "locator", "selector", "dx", "dy"],
    input: (flags) => ({ ...tab(flags), ...target(flags), deltaX: flags.dx, deltaY: flags.dy }),
  },
  eval: {
    tool: "preview_evaluate",
    flags: ["tab", "expression", "no-await"],
    input: (flags) => ({
      ...tab(flags),
      expression: flags.expression,
      awaitPromise: flags["no-await"] === true ? false : undefined,
    }),
  },
  "wait-for": {
    tool: "preview_wait_for",
    flags: ["tab", "locator", "selector", "text", "url-includes", "timeout"],
    input: (flags) => ({
      ...tab(flags),
      ...target(flags),
      text: flags.text,
      urlIncludes: flags["url-includes"],
      timeoutMs: flags.timeout,
    }),
  },
  resize: {
    tool: "preview_resize",
    flags: ["tab", "mode", "width", "height", "preset", "orientation", "timeout"],
    input: (flags) => ({
      ...tab(flags),
      mode: flags.mode,
      width: flags.width,
      height: flags.height,
      preset: flags.preset,
      orientation: flags.orientation,
      timeoutMs: flags.timeout,
    }),
  },
  appearance: {
    tool: "preview_set_appearance",
    flags: ["tab", "scheme"],
    input: (flags) => ({ ...tab(flags), colorScheme: flags.scheme }),
  },
  "record-start": { tool: "preview_recording_start", flags: ["tab"], input: tab },
  "record-stop": { tool: "preview_recording_stop", flags: ["tab"], input: tab },
};

export type ParsedBrowserArgs =
  | { readonly type: "help" }
  | { readonly type: "request"; readonly request: BrowserCliRequest }
  | { readonly type: "error"; readonly error: BrowserCliError };

const usage = (message: string): ParsedBrowserArgs => ({
  type: "error",
  error: { code: "usage", message: `${message} Run \`viewcode-browser help\` for the manual.` },
});

/**
 * Parses argv (without the program name) into one tool call. `readStdin` is
 * read only for `--text -` / `--expression -`; one trailing newline is dropped
 * so `echo hi | viewcode-browser type … --text -` does not add a line break.
 */
export const parseBrowserArgs = async (
  argv: ReadonlyArray<string>,
  readStdin: () => Promise<string>,
): Promise<ParsedBrowserArgs> => {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { type: "help" };
  }
  const command = COMMANDS[name];
  if (!command) return usage(`Unknown command "${name}".`);
  const flags: Record<string, string | number | boolean> = {};
  let stdinUsed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index]!;
    if (!raw.startsWith("--")) return usage(`Unexpected argument "${raw}".`);
    const flag = raw.slice(2);
    const kind = FLAG_KINDS[flag];
    if (!kind || !command.flags.includes(flag)) {
      return usage(`"${name}" does not take --${flag}.`);
    }
    if (flag in flags) return usage(`--${flag} was given twice.`);
    if (kind === "boolean") {
      flags[flag] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) return usage(`--${flag} needs a value.`);
    index += 1;
    if (kind === "number") {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) {
        return usage(`--${flag} must be a number.`);
      }
      flags[flag] = number;
    } else if (kind === "text" && value === "-") {
      if (stdinUsed) return usage("Only one flag can read stdin.");
      stdinUsed = true;
      flags[flag] = (await readStdin()).replace(/\r?\n$/, "");
    } else {
      flags[flag] = value;
    }
  }
  return { type: "request", request: { tool: command.tool, input: defined(command.input(flags)) } };
};

type Endpoint =
  | { readonly socketPath: string }
  | { readonly hostname: string; readonly port: number; readonly path: string };

export const parseBrowserEndpoint = (raw: string): Endpoint | undefined => {
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

/** No client timeout: the server bounds each operation, and stopping a recording can take minutes. */
const post = (endpoint: Endpoint, auth: string, body: string): Promise<PostOutcome> =>
  new Promise((resolve) => {
    const request = NodeHttp.request(
      {
        method: "POST",
        ...("socketPath" in endpoint
          ? { socketPath: endpoint.socketPath, path: BROWSER_CLI_ROUTE_PATH }
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

const isBrowserCliResponse = (value: unknown): value is { ok: boolean } => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return "result" in record;
  if (record.ok !== false || typeof record.error !== "object" || record.error === null) {
    return false;
  }
  const error = record.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
};

export interface BrowserCliIo {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly readStdin: () => Promise<string>;
  readonly writeStdout: (text: string) => void;
}

/** Runs one CLI invocation and returns its exit code. */
export const runBrowserCli = async (io: BrowserCliIo): Promise<number> => {
  const parsed = await parseBrowserArgs(io.argv, io.readStdin);
  if (parsed.type === "help") {
    io.writeStdout(BROWSER_CLI_MANUAL);
    return 0;
  }
  const fail = (error: BrowserCliError) => {
    io.writeStdout(`${JSON.stringify({ ok: false, error })}\n`);
    return 1;
  };
  if (parsed.type === "error") return fail(parsed.error);

  const rawEndpoint = io.env[BROWSER_ENDPOINT_ENV];
  const auth = io.env[BROWSER_AUTH_ENV];
  if (!rawEndpoint || !auth) {
    return fail({
      code: "unavailable",
      message:
        "The ViewCode browser is only available inside a ViewCode agent session with agent browser access on.",
    });
  }
  const endpoint = parseBrowserEndpoint(rawEndpoint);
  if (!endpoint) {
    return fail({
      code: "unavailable",
      message: `${BROWSER_ENDPOINT_ENV} is not a valid endpoint.`,
    });
  }
  const outcome = await post(endpoint, auth, JSON.stringify(parsed.request));
  if (outcome.type === "unreachable") {
    return fail({
      code: "unreachable",
      message:
        "Could not reach the ViewCode server. If your shell is sandboxed, ask the user to switch this thread to full access.",
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
        "The ViewCode server at this session's endpoint has no browser route; it probably restarted on another address or is older. Ask the user to restart the agent session.",
    });
  }
  let response: unknown;
  try {
    response = JSON.parse(outcome.body);
  } catch {
    response = undefined;
  }
  if (!isBrowserCliResponse(response)) {
    return fail({ code: "invalid-reply", message: "The ViewCode server sent an invalid reply." });
  }
  io.writeStdout(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 1;
};

const readAllStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Entry point shared by the standalone script and the executable's subcommand. */
export const runBrowserCliMain = (argv: ReadonlyArray<string>): Promise<number> =>
  runBrowserCli({
    argv,
    env: process.env,
    readStdin: readAllStdin,
    writeStdout: (text) => process.stdout.write(text),
  });

export const BROWSER_CLI_MANUAL = `viewcode-browser: drive ViewCode's collaborative browser, the one the user
sees in their ViewCode window, from your shell.

Every command prints one JSON line: {"ok":true,"result":…} (exit 0) or
{"ok":false,"error":{"code":…,"message":…}} (exit 1). Read the message: it
says what to do next.

COMMANDS
  status                                   is a browser attached? url, title, tab
  open [--url URL] [--background] [--new-tab]
                                           open the thread's browser tab (shown
                                           to the user unless --background)
  navigate --url URL | --port N [--path /p] [--https]
           [--wait load|domContentLoaded|none] [--timeout MS]
                                           go to a page or a local dev server
  snapshot [--no-image]                    page state: text, interactive elements
                                           with locators, console and network
                                           logs, and "screenshotPath", a PNG
                                           you can open and show the user
  click --locator L | --selector CSS | --x X --y Y [--timeout MS]
  type --text T|- (--locator L | --selector CSS) [--clear] [--timeout MS]
  press --key K [--modifiers Meta,Shift]   e.g. --key Enter, --key a --modifiers Meta
  scroll [--dx N] [--dy N] [--locator L | --selector CSS]
  eval --expression JS|- [--no-await]      run JavaScript; returns {"value":…}
  wait-for [--locator L] [--selector CSS] [--text T] [--url-includes S]
           [--timeout MS]
  resize --mode fill | --mode freeform --width W --height H
         | --mode preset --preset ID [--orientation portrait|landscape]
  appearance --scheme dark|light|system
  record-start / record-stop               record the tab; stop returns the video
                                           file path
Every command takes --tab ID to act on a specific tab; otherwise it uses this
session's current tab. --text - and --expression - read stdin.

LOCATORS
  Prefer Playwright locators from snapshot's interactive elements, such as
  role=button[name='Send'] or text=Continue; CSS (--selector) is the fallback.

THE LOOP
  1. status; if no tab is attached, open (add --url to start somewhere).
  2. navigate to the page or --port of the dev server.
  3. snapshot to see the page before acting; open screenshotPath to look.
  4. Act once (click, type, press, scroll), then snapshot or wait-for to check.
To show the user a screenshot, embed screenshotPath in your reply as
![description](screenshotPath).

ERRORS
  usage            fix the command line.
  unavailable      not in a ViewCode session with agent browser access, or the
                   user turned "Agent browser access" off: tell the user.
  unreachable      the server could not be reached; if your shell is sandboxed,
                   ask the user to switch this thread to full access.
  credential       ask the user to restart the agent session.
  Preview…Error    from the browser itself (for example no ViewCode desktop app
                   is open to host the browser, a locator matched nothing, or a
                   timeout); its message says whether to retry.
`;
