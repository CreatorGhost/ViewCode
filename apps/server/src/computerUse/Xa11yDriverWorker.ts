// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the driver worker is a plain Node child process outside the Effect runtime.
/**
 * The IPC loop of the computer-use driver process. The server forks it with
 * the app's own executable and `ELECTRON_RUN_AS_NODE=1`, so on macOS it runs
 * as the app and uses its Accessibility and Screen Recording grants.
 * `VIEWCODE_COMPUTER_DRIVER_HOST=helper` opts into the sibling Helper host;
 * its grant attribution must be checked in the actual desktop build before
 * changing the default. See `Xa11yComputerDriver.ts`.
 *
 * xa11y loads on the first request, so a missing native module answers
 * `status` with "unavailable" instead of killing the process.
 *
 * The parent passes a random nonce in `DRIVER_NONCE_ENV` and repeats it in
 * every request; without it the worker exits. This only stops casual direct
 * use of this hidden entry. It does not contain an agent with an
 * unrestricted shell, which can drive the desktop by other means anyway; the
 * computer-use gate is the server, for agents that go through it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { ComputerUseError } from "@t3tools/contracts";

import { makeMacBackgroundInput } from "./MacBackgroundInput.ts";
import { makeMacMenuAccessibility } from "./MacMenuAccessibility.ts";

const backgroundInput = makeMacBackgroundInput();
const menus = makeMacMenuAccessibility();

import {
  macCaptureWindow,
  macDrag,
  macEnableManualAccessibility,
  macReleaseMouse,
  macSecondsSinceInput,
} from "./MacQuartz.ts";
import {
  appBundlePath,
  DRIVER_EPOCH_ENV,
  DRIVER_NONCE_ENV,
  makeDriverCore,
  type DriverRequest,
  type DriverResult,
  type Xa11yApi,
} from "./Xa11yDriverCore.ts";

type Xa11yModule = typeof import("@crowecawcaw/xa11y");

// Windows is not supported yet: xa11y lists each top-level window as its own
// app there, which the window model here does not handle.
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);
// oxlint-disable-next-line t3code/no-global-process-runtime -- The driver worker has no Effect runtime.
const PLATFORM = process.platform;

/** macOS: one `ps` call; Linux: `/proc/<pid>/exe`; elsewhere nothing. */
const executablePaths = async (
  pids: ReadonlyArray<number>,
): Promise<ReadonlyMap<number, string>> => {
  const paths = new Map<number, string>();
  if (pids.length === 0) return paths;
  if (PLATFORM === "darwin") {
    const output = await new Promise<string>((resolve) => {
      NodeChildProcess.execFile(
        "/bin/ps",
        ["-o", "pid=,comm=", "-p", pids.join(",")],
        { timeout: 2_000 },
        (_error, stdout) => resolve(stdout ?? ""),
      );
    });
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match?.[1] && match[2]) paths.set(Number(match[1]), match[2]);
    }
  } else if (PLATFORM === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        const path = await NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => undefined);
        if (path) paths.set(pid, path);
      }),
    );
  }
  return paths;
};

const execFileQuietly = (command: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve) => {
    NodeChildProcess.execFile(command, [...args], { timeout: 2_000 }, () => resolve());
  });

/**
 * macOS: `open -a <bundle>` activates the app (no shell; the path comes
 * from the process table). Elsewhere raising the window is all there is.
 */
const activateApp = async (pid: number) => {
  if (PLATFORM !== "darwin") return;
  const bundle = appBundlePath((await executablePaths([pid])).get(pid) ?? "");
  if (bundle) await execFileQuietly("/usr/bin/open", ["-a", bundle]);
};

const withMenus = async (
  pid: number | null,
  children: Awaited<ReturnType<import("@crowecawcaw/xa11y").App["children"]>>,
) => {
  if (
    PLATFORM !== "darwin" ||
    pid === null ||
    children.some((element) => element.role === "menu_bar") ||
    !children.some((element) => ["window", "dialog", "alert"].includes(element.role))
  )
    return children;
  return [...children, ...(await menus.list(pid).catch(() => []))];
};

export const makeXa11yApi = (xa11y: Xa11yModule): Omit<Xa11yApi, "authorizeInput"> => ({
  listApps: async () => {
    const apps = await xa11y.App.list();
    for (const app of apps) {
      const children = app.children.bind(app);
      app.children = async () => withMenus(app.pid, await children());
    }
    return apps;
  },
  appWindows: async (pid) => {
    const children = await (await xa11y.App.byPid(pid, { timeout: 0 })).children();
    return withMenus(pid, children);
  },
  elementIsAlive: async (element) =>
    menus.owns(element) ? menus.alive(element) : (await element.parent()) !== null,
  foregroundPid: async () =>
    PLATFORM === "darwin"
      ? backgroundInput.foregroundPid()
      : (await xa11y.App.foreground({ timeout: 0 })).pid,
  inputSim: () => xa11y.inputSim(),
  ...(PLATFORM === "darwin" && process.env.VIEWCODE_COMPUTER_BACKGROUND === "1"
    ? { backgroundInput: backgroundInput.dispatch }
    : {}),
  pointerDrag:
    PLATFORM === "darwin"
      ? macDrag
      : (from, to) => xa11y.inputSim().drag([from.x, from.y], [to.x, to.y]),
  releaseMouse: PLATFORM === "darwin" ? macReleaseMouse : () => xa11y.inputSim().mouseUp("left"),
  secondsSinceInput: async () => (PLATFORM === "darwin" ? macSecondsSinceInput() : null),
  enableAccessibility: async (pid) =>
    PLATFORM === "darwin" ? macEnableManualAccessibility(pid) : false,
  screenshot: (element) => {
    if (menus.owns(element))
      throw Object.assign(new Error("Menu screenshots need readable native bounds."), {
        name: "CaptureFailedError",
      });
    return xa11y.screenshot({ element });
  },
  captureWindow: async (pid, bounds, outputPath, maxSize, options) =>
    PLATFORM === "darwin" ? macCaptureWindow(pid, bounds, outputPath, maxSize, options) : null,
  executablePaths,
  writeFile: async (path, bytes) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, bytes);
  },
  activateApp,
  // A full capture of the primary display: its logical size, origin (0, 0).
  primaryDisplay: async () => {
    const shot = await xa11y.screenshot();
    return { x: 0, y: 0, width: shot.width / shot.scale, height: shot.height / shot.scale };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
});

type Envelope = { readonly id: number; readonly nonce: string; readonly request: DriverRequest };

const sameNonce = (expected: Buffer, received: unknown) => {
  if (typeof received !== "string") return false;
  const bytes = Buffer.from(received);
  return bytes.length === expected.length && NodeCrypto.timingSafeEqual(bytes, expected);
};

const unavailable =
  (reason: string): ((request: DriverRequest) => DriverResult) =>
  (request) =>
    request.op === "status"
      ? { ok: true, result: { available: false, accessibility: "unknown", reason } }
      : { ok: false, error: { kind: "unavailable", message: reason, dispatched: "no" } };

const loadHandler = (
  authorizeInput: Xa11yApi["authorizeInput"],
  epoch: string,
): ((request: DriverRequest) => Promise<DriverResult> | DriverResult) => {
  if (!SUPPORTED_PLATFORMS.has(PLATFORM)) {
    return unavailable(
      PLATFORM === "win32"
        ? "Computer use is not supported on Windows yet."
        : "Computer use is not supported on this platform.",
    );
  }
  let xa11y: Xa11yModule;
  try {
    xa11y = NodeModule.createRequire(import.meta.url)("@crowecawcaw/xa11y") as Xa11yModule;
  } catch {
    return unavailable("The accessibility driver is not installed for this platform.");
  }
  // App lookups would otherwise poll for 5 s on a miss.
  xa11y.setDefaultTimeout(0);
  return makeDriverCore(
    { ...makeXa11yApi(xa11y), authorizeInput },
    { platform: PLATFORM, epoch, background: process.env.VIEWCODE_COMPUTER_BACKGROUND === "1" },
  ).handle;
};

/** Answers one request at a time over the fork IPC channel until the parent disconnects. */
export const runComputerUseDriverWorker = (): Promise<void> =>
  new Promise((resolve) => {
    const send = process.send?.bind(process);
    const nonce = process.env[DRIVER_NONCE_ENV] ?? "";
    delete process.env[DRIVER_NONCE_ENV];
    // The parent's choice, so its logs name this worker's handles; it is
    // part of every handle, so anything but plain hex gets a fresh one.
    const parentEpoch = process.env[DRIVER_EPOCH_ENV] ?? "";
    delete process.env[DRIVER_EPOCH_ENV];
    const epoch = /^[0-9a-f]{8,32}$/.test(parentEpoch)
      ? parentEpoch
      : NodeCrypto.randomBytes(4).toString("hex");
    if (!send || nonce.length < 32) {
      process.stderr.write("computer-use-driver is started by the ViewCode server only.\n");
      process.exitCode = 2;
      process.disconnect?.();
      resolve();
      return;
    }
    const expected = Buffer.from(nonce);
    let handler: ReturnType<typeof loadHandler> | undefined;
    let queue = Promise.resolve();
    let activeId: number | undefined;
    let authorize: ((error: ComputerUseError | undefined) => void) | undefined;
    process.on("message", (message: Envelope) => {
      if (!sameNonce(expected, message?.nonce)) process.exit(2);
      if ("decision" in message) {
        if (message.id !== activeId || !authorize) process.exit(2);
        const complete = authorize;
        authorize = undefined;
        complete((message.decision ?? undefined) as ComputerUseError | undefined);
        return;
      }
      queue = queue.then(async () => {
        activeId = message.id;
        handler ??= loadHandler(
          (target, phase) =>
            new Promise((complete) => {
              authorize = complete;
              send({ id: activeId, authorize: target, phase });
            }),
          epoch,
        );
        let reply: DriverResult;
        try {
          reply = await handler(message.request);
        } catch {
          reply = {
            ok: false,
            error: {
              kind: "failed",
              message: "The driver failed unexpectedly.",
              dispatched: "unknown",
            },
          };
        }
        send({ id: message.id, ...reply });
        activeId = undefined;
      });
    });
    process.once("exit", () => {
      backgroundInput.close();
      menus.close();
    });
    process.once("disconnect", () => {
      backgroundInput.close();
      menus.close();
      resolve();
      process.exit(0);
    });
  });
