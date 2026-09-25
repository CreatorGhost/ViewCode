// @effect-diagnostics nodeBuiltinImport:off - socket files need lstat/isSocket/chmod, which FileSystem does not expose.
/**
 * Helpers for serving HTTP on a Unix domain socket (Windows: a named pipe)
 * instead of a TCP port. The desktop app uses this so its local backend opens
 * no network listener at all; see `ServerConfig.listenPath`.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Undici from "@effect/platform-node/Undici";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ListenPathUnavailableError extends Schema.TaggedError<ListenPathUnavailableError>()(
  "ListenPathUnavailableError",
  {
    listenPath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot listen on ${this.listenPath}: ${this.reason}`;
  }
}

/** `\\.\pipe\name` and `\\?\pipe\name` address Windows named pipes, not files. */
export const isWindowsNamedPipePath = (listenPath: string): boolean =>
  /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(listenPath);

const probeSocket = (listenPath: string) =>
  new Promise<"live" | "stale">((resolve) => {
    const socket = NodeNet.connect({ path: listenPath });
    const finish = (result: "live" | "stale") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", () => finish("stale"));
  });

/**
 * Makes `listenPath` bindable. A socket file left behind by a crashed server is
 * removed; a socket that still accepts connections belongs to a running server
 * and is left alone, as is anything that is not a socket.
 */
export const prepareListenPath = Effect.fn("socketListener.prepareListenPath")(function* (
  listenPath: string,
) {
  if (isWindowsNamedPipePath(listenPath)) return;
  const fail = (reason: string) => new ListenPathUnavailableError({ listenPath, reason });

  const directory = NodePath.dirname(listenPath);
  yield* Effect.tryPromise({
    try: async () => {
      // Only the owner may reach into a directory we create, which closes the
      // window between bind and the chmod below.
      await NodeFS.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      return await NodeFS.promises.lstat(directory);
    },
    catch: (cause) => fail(`could not create ${directory}: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((directoryStat) => {
      if (!directoryStat.isDirectory()) {
        return Effect.fail(fail(`${directory} is not a directory`));
      }
      // Another account's directory could let that account swap the socket;
      // system directories such as /tmp are root-owned and fine.
      const uid = process.getuid?.();
      return uid !== undefined && directoryStat.uid !== uid && directoryStat.uid !== 0
        ? Effect.fail(fail(`${directory} is owned by another user`))
        : Effect.void;
    }),
  );

  const stat = yield* Effect.promise(() => NodeFS.promises.lstat(listenPath).catch(() => null));
  if (stat === null) return;
  if (!stat.isSocket()) {
    return yield* fail("the path exists and is not a socket");
  }
  if ((yield* Effect.promise(() => probeSocket(listenPath))) === "live") {
    return yield* fail("another server is already listening on it");
  }
  yield* Effect.tryPromise({
    try: () => NodeFS.promises.unlink(listenPath),
    catch: (cause) => fail(`could not remove the stale socket: ${String(cause)}`),
  });
});

/**
 * Restricts a freshly bound socket to its owner. Called from the server's
 * `listening` event, before any request is accepted.
 */
export const restrictListenPathPermissions = (listenPath: string): void => {
  if (isWindowsNamedPipePath(listenPath)) return;
  NodeFS.chmodSync(listenPath, 0o600);
};

/**
 * A `fetch` that sends every request over `listenPath`, whatever authority the
 * URL names. For CLI commands that talk to a running socket-mode server.
 */
export const makeListenPathFetch = (listenPath: string): typeof globalThis.fetch => {
  const dispatcher = new Undici.Agent({ connect: { socketPath: listenPath } });
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    Undici.fetch(input as Parameters<typeof Undici.fetch>[0], {
      ...(init as Parameters<typeof Undici.fetch>[1]),
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
};
