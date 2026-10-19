// @effect-diagnostics nodeBuiltinImport:off - These tests exercise actual private socket and TCP listeners.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import { makeListenPathFetch } from "../socketListener.ts";
import * as ViewCodeHttpServer from "./viewcodeHttpServer.ts";

const layerRoutes = HttpRouter.add("GET", "/readyz", HttpServerResponse.text("ready"));

const startServer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.build(
    HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
      Layer.provideMerge(ViewCodeHttpServer.layer),
      Layer.provide(ServerConfig.layer(config)),
    ),
  );

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "vc-http-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("ViewCode HTTP binding", (it) => {
  it.effect("binds only the configured socket while its nominal TCP port is occupied", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vc-http-" });
      const isWindows = HostProcessPlatform.defaultValue() === "win32";
      const listenPath = isWindows
        ? `\\\\.\\pipe\\viewcode-http-${path.basename(directory)}`
        : path.join(directory, "run", "backend.sock");
      const occupied = NodeHttp.createServer((_request, response) => response.end("occupied"));
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve)),
        ),
        () => Effect.promise(() => new Promise<void>((resolve) => occupied.close(() => resolve()))),
      );
      const occupiedAddress = occupied.address();
      assert.isNotNull(occupiedAddress);
      if (occupiedAddress === null || typeof occupiedAddress === "string") return;
      const services = yield* startServer({
        ...config,
        host: "127.0.0.1",
        port: occupiedAddress.port,
        listenPath,
      });
      const server = Context.get(services, HttpServer.HttpServer);
      assert.equal(server.address._tag, "UnixPathAddress");
      if (server.address._tag !== "UnixPathAddress") return;
      assert.equal(server.address.path, listenPath);
      if (!isWindows) {
        assert.equal(NodeFS.statSync(path.dirname(listenPath)).mode & 0o777, 0o700);
        assert.equal(NodeFS.statSync(listenPath).mode & 0o777, 0o600);
      }
      const body = yield* Effect.promise(async () =>
        (await makeListenPathFetch(listenPath)("http://localhost/readyz")).text(),
      );
      assert.equal(body, "ready");
      const otherBody = yield* HttpClient.get(
        `http://127.0.0.1:${occupiedAddress.port}/readyz`,
      ).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );
      assert.equal(otherBody, "occupied");
    }).pipe(Effect.scoped),
  );

  it.effect("retains normal TCP binding when no socket is configured", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const services = yield* startServer({ ...config, host: "127.0.0.1", port: 0 });
      const server = Context.get(services, HttpServer.HttpServer);
      assert.equal(server.address._tag, "InetAddressV4");
      if (server.address._tag !== "InetAddressV4") return;
      const port = server.address.port;
      const body = yield* HttpClient.get(`http://127.0.0.1:${port}/readyz`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );
      assert.equal(body, "ready");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an occupied non-socket path instead of falling back to TCP", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vc-http-" });
      const listenPath = path.join(directory, "keep-file");
      yield* fs.writeFileString(listenPath, "keep this file");
      const refused = yield* startServer({ ...config, port: 0, listenPath }).pipe(Effect.flip);
      assert.equal(refused._tag, "ListenPathUnavailableError");
      assert.equal(yield* fs.readFileString(listenPath), "keep this file");
    }).pipe(Effect.scoped),
  );
});
