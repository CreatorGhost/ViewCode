import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionTarget, type ConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

// ViewCode guard (467f7d411): pairing an address again under a new id deletes the old
// route's credential, so the routes learned over that route must go with it.

const ENVIRONMENT_ID = EnvironmentId.make("environment-desk");
const TAILNET_URL = "https://desk.tail1234.ts.net/";
const CREDENTIAL = new BearerConnectionCredential({ token: "bearer-token" });

const LEGACY = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  connectionId: `bearer:${ENVIRONMENT_ID}`,
});
const LEGACY_PROFILE = new BearerConnectionProfile({
  connectionId: LEGACY.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  httpBaseUrl: TAILNET_URL,
  wsBaseUrl: "wss://desk.tail1234.ts.net/",
});
// Learned over the legacy route, so it borrows that route's token.
const LEARNED = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  connectionId: `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@${LEGACY.connectionId}`,
});
const LEARNED_PROFILE = new BearerConnectionProfile({
  connectionId: LEARNED.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  httpBaseUrl: "http://192.168.1.10:3773/",
  wsBaseUrl: "ws://192.168.1.10:3773/",
  learned: true,
});

const mapRef = <V>(entries: ReadonlyArray<readonly [string, V]>) => Ref.make(new Map(entries));
const setIn =
  <V>(key: string, value: V) =>
  (current: Map<string, V>) =>
    new Map(current).set(key, value);
const deleteIn =
  (key: string) =>
  <V>(current: Map<string, V>) => {
    const next = new Map(current);
    next.delete(key);
    return next;
  };

const makeHarness = Effect.gen(function* () {
  const targets = yield* Ref.make<ReadonlyArray<ConnectionTarget>>([LEARNED, LEGACY]);
  const profiles = yield* mapRef<ConnectionProfile>([
    [LEARNED.connectionId, LEARNED_PROFILE],
    [LEGACY.connectionId, LEGACY_PROFILE],
  ]);
  const credentials = yield* mapRef<ConnectionCredential>([[LEGACY.connectionId, CREDENTIAL]]);
  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, {
          list: Ref.get(targets),
          listDisabled: Effect.succeed([]),
        }),
        Layer.succeed(Persistence.ConnectionRegistrationStore, {
          register: (registration, routes) =>
            Ref.set(targets, routes).pipe(
              Effect.andThen(
                registration._tag === "RelayConnectionRegistration"
                  ? Effect.void
                  : Ref.update(
                      profiles,
                      setIn(registration.profile.connectionId, registration.profile),
                    ).pipe(
                      Effect.andThen(
                        Ref.update(
                          credentials,
                          setIn(registration.target.connectionId, registration.credential),
                        ),
                      ),
                    ),
              ),
            ),
          setRoutes: (_environmentId, routes) => Ref.set(targets, routes),
          remove: () => Ref.set(targets, []),
          setEnabled: () => Effect.void,
        }),
        Layer.succeed(Persistence.EnvironmentCacheStore, {
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: (id) =>
            Ref.get(profiles).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(id)))),
          put: (profile) => Ref.update(profiles, setIn(profile.connectionId, profile)),
          remove: (id) => Ref.update(profiles, deleteIn(id)),
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: (id) =>
            Ref.get(credentials).pipe(Effect.map((map) => Option.fromUndefinedOr(map.get(id)))),
          put: (id, credential) => Ref.update(credentials, setIn(id, credential)),
          remove: (id) => Ref.update(credentials, deleteIn(id)),
        }),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
          get: () => Effect.succeedNone,
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
          provision: () => Effect.die(new Error("unused")),
          prepare: () => Effect.die(new Error("unused")),
          disconnect: () => Effect.void,
        }),
        Layer.succeed(Connectivity.Connectivity, {
          status: Effect.succeed("online" as const),
          changes: Stream.never,
        }),
        Layer.succeed(ConnectionWakeups.ConnectionWakeups, { changes: Stream.never }),
        // Connecting is not under test: an attempt waits forever and sends nothing.
        Layer.succeed(ConnectionDriver.ConnectionDriver, {
          connect: () => Effect.never,
          checkRoute: () => Effect.succeed("unchecked"),
          preflight: () => Effect.succeed(false),
        }),
      ),
    ),
  );
  return { layer, targets };
});

describe("EnvironmentRegistry re-pairing (ViewCode)", () => {
  it.effect("pairing a legacy address again drops the routes learned over its old token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const tailnet = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        connectionId: `bearer:${ENVIRONMENT_ID}:${TAILNET_URL}`,
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: tailnet,
            profile: new BearerConnectionProfile({
              ...LEGACY_PROFILE,
              connectionId: tailnet.connectionId,
            }),
            credential: CREDENTIAL,
          }),
        );
        expect(yield* Ref.get(harness.targets)).toEqual([tailnet]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
