import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { catalogRoutes, registerConnectionInCatalog } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("drops saved relay targets from the current catalog and persists the result", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [
            { _tag: "RelayConnectionTarget", environmentId: "relay-env", label: "Relay" },
            {
              _tag: "BearerConnectionTarget",
              environmentId: "bearer-env",
              label: "Mac",
              connectionId: "bearer:bearer-env",
            },
          ],
          profiles: [],
          credentials: [],
          remoteDpopTokens: [],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets.map((target) => target.environmentId)).toEqual([
        "bearer-env",
      ]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toContain("RelayConnectionTarget");
    }),
  );

  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );

  it.effect("keeps an environment's direct route when dropping its relay route", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              environmentId: "desk",
              label: "Desk",
              connectionId: "bearer:desk",
            },
            { _tag: "RelayConnectionTarget", environmentId: "desk", label: "Desk" },
          ],
          profiles: [],
          credentials: [],
          remoteDpopTokens: [],
          disabledEnvironmentIds: ["desk"],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );
      const document = yield* catalog.read;

      expect(document.targets.map((target) => target._tag)).toEqual(["BearerConnectionTarget"]);
      expect(document.disabledEnvironmentIds).toEqual(["desk"]);
    }),
  );

  // A phone paired before environments had several routes must keep working
  // without pairing again, and learning a second address must not cost it its
  // saved credential.
  it.effect("migrates a catalog saved before routes existed without re-pairing", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("desk");
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              environmentId,
              label: "Desk",
              connectionId: "bearer:desk",
            },
          ],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "bearer:desk",
              environmentId,
              label: "Desk",
              httpBaseUrl: "https://desk.tail1234.ts.net/",
              wsBaseUrl: "wss://desk.tail1234.ts.net/",
            },
          ],
          credentials: [
            {
              connectionId: "bearer:desk",
              credential: { _tag: "BearerConnectionCredential", token: "saved-token" },
            },
          ],
          remoteDpopTokens: [],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );
      const saved = yield* catalog.read;
      expect(catalogRoutes(saved, environmentId).map((target) => target._tag)).toEqual([
        "BearerConnectionTarget",
      ]);

      // A LAN route under the new per-address id joins the saved one.
      const lan = new BearerConnectionTarget({
        environmentId,
        label: "Desk",
        connectionId: "bearer:desk:http://192.168.1.10:3773",
      });
      const [legacy] = catalogRoutes(saved, environmentId);
      yield* catalog.update((document) =>
        registerConnectionInCatalog(
          document,
          new BearerConnectionRegistration({
            target: lan,
            profile: new BearerConnectionProfile({
              connectionId: lan.connectionId,
              environmentId,
              label: "Desk",
              httpBaseUrl: "http://192.168.1.10:3773/",
              wsBaseUrl: "ws://192.168.1.10:3773/",
            }),
            credential: new BearerConnectionCredential({ token: "lan-token" }),
          }),
          [lan, legacy!],
        ),
      );

      const reloaded = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
        Effect.flatMap((store) => store.read),
      );
      expect(
        catalogRoutes(reloaded, environmentId).map((target) =>
          target._tag === "BearerConnectionTarget" ? target.connectionId : target._tag,
        ),
      ).toEqual(["bearer:desk:http://192.168.1.10:3773", "bearer:desk"]);
      expect(
        reloaded.credentials.map((entry) => [entry.connectionId, entry.credential.token]),
      ).toEqual([
        ["bearer:desk", "saved-token"],
        ["bearer:desk:http://192.168.1.10:3773", "lan-token"],
      ]);
    }),
  );
});
