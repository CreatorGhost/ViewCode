/**
 * Serves `t3code-backend://<instance id>/` for the renderer: HTTP through
 * `protocol.handle` and WebSockets through an IPC `MessagePort`, both carried
 * to the instance's socket by DesktopLocalBackendSocket.
 */
import { DESKTOP_LOCAL_BACKEND_SCHEME } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import { forwardRequestToSocket, openSocketTunnel } from "./DesktopLocalBackendSocket.ts";

export class DesktopLocalBackendTransportInstallError extends Schema.TaggedError<DesktopLocalBackendTransportInstallError>()(
  "DesktopLocalBackendTransportInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to install the local backend transport.";
  }
}

export class DesktopLocalBackendTransport extends Context.Service<
  DesktopLocalBackendTransport,
  {
    /**
     * Serves the backend scheme and the socket tunnel IPC for the app's
     * lifetime. Safe to call when no backend uses a socket: requests then 502.
     */
    readonly install: Effect.Effect<void, DesktopLocalBackendTransportInstallError, Scope.Scope>;
  }
>()("@t3tools/desktop/backend/DesktopLocalBackendTransport") {}

const badGateway = (message: string) =>
  new Response(message, { status: 502, headers: { "content-type": "text/plain" } });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  // The socket path of the instance a `t3code-backend://<id>/` URL names.
  const socketPathFor = (rawUrl: string) =>
    Effect.gen(function* () {
      const host = new URL(rawUrl).host;
      const instances = yield* pool.list;
      const instance = instances.find((candidate) => candidate.id === host);
      if (instance === undefined) return Option.none<string>();
      const config = yield* instance.currentConfig;
      return Option.flatMap(config, (value) => Option.fromNullishOr(value.listenPath));
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

  const handleRequest = async (request: Request): Promise<Response> => {
    const socketPath = await runPromise(socketPathFor(request.url));
    if (Option.isNone(socketPath)) return badGateway("The local backend is not running.");
    try {
      return await forwardRequestToSocket(request, socketPath.value);
    } catch (error) {
      return badGateway(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTunnel = (event: Electron.IpcMainEvent, raw: unknown) => {
    const port = event.ports[0];
    if (port === undefined) return;
    // Only the app's own renderer may open backend sockets.
    const senderUrl = event.senderFrame?.url ?? "";
    if (!senderUrl.startsWith("t3code:") && !senderUrl.startsWith("t3code-dev:")) {
      port.close();
      return;
    }
    const input = raw as { readonly url?: unknown; readonly protocols?: unknown };
    const url = typeof input?.url === "string" ? input.url : "";
    const protocols = Array.isArray(input?.protocols)
      ? input.protocols.filter((entry): entry is string => typeof entry === "string")
      : [];
    const fail = (message: string) => {
      port.postMessage({ type: "error", message });
      port.postMessage({ type: "close", code: 1006, reason: message, wasClean: false });
      port.close();
    };
    if (!url.toLowerCase().startsWith(`${DESKTOP_LOCAL_BACKEND_SCHEME}:`)) {
      fail("Not a local backend URL.");
      return;
    }
    void runPromise(socketPathFor(url)).then((socketPath) => {
      if (Option.isNone(socketPath)) {
        fail("The local backend is not running.");
        return;
      }
      openSocketTunnel({ url, protocols, socketPath: socketPath.value, port });
    });
  };

  const install = Effect.acquireRelease(
    Effect.try({
      try: () => {
        Electron.protocol.handle(DESKTOP_LOCAL_BACKEND_SCHEME, handleRequest);
        Electron.ipcMain.on(IpcChannels.OPEN_LOCAL_BACKEND_SOCKET_CHANNEL, handleTunnel);
      },
      catch: (cause) => new DesktopLocalBackendTransportInstallError({ cause }),
    }),
    () =>
      Effect.sync(() => {
        Electron.ipcMain.removeListener(
          IpcChannels.OPEN_LOCAL_BACKEND_SOCKET_CHANNEL,
          handleTunnel,
        );
        Electron.protocol.unhandle(DESKTOP_LOCAL_BACKEND_SCHEME);
      }),
  );

  return DesktopLocalBackendTransport.of({ install });
});

export const layer = Layer.effect(DesktopLocalBackendTransport, make);
