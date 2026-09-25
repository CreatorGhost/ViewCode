// @effect-diagnostics nodeBuiltinImport:off - exercises real socket files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  isWindowsNamedPipePath,
  makeListenPathFetch,
  prepareListenPath,
  restrictListenPathPermissions,
} from "./socketListener.ts";

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-listen-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

const listen = (server: NodeNet.Server, path: string) =>
  Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(path, resolve))),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("socket listener", () => {
  it.effect("creates a private directory and serves HTTP only to the owner", () =>
    Effect.gen(function* () {
      const listenPath = NodePath.join(yield* tempDirectory, "run", "backend.sock");
      yield* prepareListenPath(listenPath);
      assert.equal(NodeFS.statSync(NodePath.dirname(listenPath)).mode & 0o777, 0o700);

      const server = NodeHttp.createServer((_request, response) => response.end("ok"));
      server.once("listening", () => restrictListenPathPermissions(listenPath));
      yield* listen(server, listenPath);

      assert.equal(NodeFS.statSync(listenPath).mode & 0o777, 0o600);
      const body = yield* Effect.promise(async () => {
        const response = await makeListenPathFetch(listenPath)("http://localhost/readyz");
        return response.text();
      });
      assert.equal(body, "ok");
    }).pipe(Effect.scoped),
  );

  it.effect("removes a stale socket left by a crashed server", () =>
    Effect.gen(function* () {
      const listenPath = NodePath.join(yield* tempDirectory, "backend.sock");
      // A killed process leaves its socket file behind; a clean close unlinks it.
      yield* Effect.promise(async () => {
        const crashed = NodeChildProcess.spawn(process.execPath, [
          "-e",
          'require("node:net").createServer().listen(process.argv[1], () => console.log("up"))',
          listenPath,
        ]);
        await new Promise((resolve) => crashed.stdout.once("data", resolve));
        crashed.kill("SIGKILL");
        await new Promise((resolve) => crashed.once("exit", resolve));
      });
      assert.isTrue(NodeFS.lstatSync(listenPath).isSocket());

      yield* prepareListenPath(listenPath);
      assert.isFalse(NodeFS.existsSync(listenPath));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a socket another server is still listening on", () =>
    Effect.gen(function* () {
      const listenPath = NodePath.join(yield* tempDirectory, "backend.sock");
      yield* listen(NodeNet.createServer(), listenPath);

      const error = yield* Effect.flip(prepareListenPath(listenPath));
      assert.include(error.message, "already listening");
      assert.isTrue(NodeFS.lstatSync(listenPath).isSocket());
    }).pipe(Effect.scoped),
  );

  it.effect("never deletes a file that is not a socket", () =>
    Effect.gen(function* () {
      const listenPath = NodePath.join(yield* tempDirectory, "backend.sock");
      NodeFS.writeFileSync(listenPath, "keep me");

      const error = yield* Effect.flip(prepareListenPath(listenPath));
      assert.include(error.message, "not a socket");
      assert.equal(NodeFS.readFileSync(listenPath, "utf8"), "keep me");
    }).pipe(Effect.scoped),
  );
});

describe("named pipe paths", () => {
  it("recognizes Windows pipe addresses", () => {
    assert.isTrue(isWindowsNamedPipePath("\\\\.\\pipe\\t3code-backend-abc"));
    assert.isTrue(isWindowsNamedPipePath("//./pipe/t3code"));
    assert.isFalse(isWindowsNamedPipePath("/tmp/t3code/backend.sock"));
  });
});
