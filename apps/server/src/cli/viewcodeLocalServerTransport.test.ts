// @effect-diagnostics nodeBuiltinImport:off -- Real local HTTP transport coverage without launching an application server.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { vi } from "vite-plus/test";

import { withLocalServerTransport } from "./viewcodeLocalServerTransport.ts";

it.effect(
  "uses the native projects HTTP API over the persisted socket and preserves bearer auth",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cliuds-")),
      );
      const socketPath =
        HostProcess.Platform.defaultValue() === "win32"
          ? `\\\\.\\pipe\\${NodePath.basename(directory)}`
          : NodePath.join(directory, "s.sock");
      const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"projects":[],"updatedAt":"2026-10-18T00:00:00.000Z"}');
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          }),
      );
      expect(server.address()).toBe(socketPath);
      const snapshot = yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
          baseUrl: "http://unused.invalid:3773",
        });
        return yield* client.projects.snapshot({
          headers: { authorization: "Bearer local-test-only" },
        });
      }).pipe(withLocalServerTransport({ listenPath: socketPath }));
      expect(snapshot.projects).toEqual([]);
      expect(requests).toEqual([
        { path: "/api/projects", authorization: "Bearer local-test-only" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);

it.effect(
  "fails a missing socket without falling back to TCP and restores ordinary HTTP outside its scope",
  () =>
    Effect.gen(function* () {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('{"ordinary":true}'));
      yield* Effect.addFinalizer(() => Effect.sync(() => fetch.mockRestore()));
      const client = yield* HttpClient.HttpClient;
      const result = yield* client.get("http://unused.invalid:3773/api/projects").pipe(
        withLocalServerTransport({
          listenPath: NodePath.join(
            NodeOS.tmpdir(),
            `absent-viewcode-${NodePath.basename(NodeOS.tmpdir())}.sock`,
          ),
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(fetch).not.toHaveBeenCalled();
      const response = yield* client.get("http://ordinary.invalid/path");
      expect(yield* response.json).toEqual({ ordinary: true });
      expect(fetch).toHaveBeenCalledOnce();
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);
