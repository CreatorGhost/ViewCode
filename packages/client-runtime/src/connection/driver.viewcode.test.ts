import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as Descriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  RelayConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RpcSession from "../rpc/session.ts";

// ViewCode guard (a8703a320): a saved LAN address that another environment answers
// (the same IP on a different network) is never tried, so its token is never sent there.

const ENVIRONMENT_ID = EnvironmentId.make("environment-desk");
const LAN_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Desk",
  connectionId: "bearer:lan",
});
const RELAY_TARGET = new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Desk" });
const LAN_THEN_RELAY: ConnectionCatalogEntry = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
  alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
  enabled: true,
};

const encodeDescriptor = Schema.encodeSync(Schema.fromJsonString(ExecutionEnvironmentDescriptor));
const answeredBy = (environmentId: string) =>
  HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(
          encodeDescriptor({
            environmentId: EnvironmentId.make(environmentId),
            label: "Somebody else's machine",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.1.0",
            capabilities: { repositoryIdentity: true },
          } satisfies Descriptor),
        ),
      ),
    ),
  );

const driverWith = (httpClient: HttpClient.HttpClient, prepared: Array<ConnectionTarget>) =>
  ConnectionDriver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(ConnectionResolver.ConnectionResolver, {
          prepare: (entry) =>
            Effect.sync(() => prepared.push(entry.target)).pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionBlockedError({ reason: "authentication", detail: "Sign in." }),
                ),
              ),
            ),
          prepareForUpdate: () => Effect.die(new Error("unused")),
        }),
        Layer.succeed(RpcSession.RpcSessionFactory, {
          connect: () => Effect.die(new Error("unused")),
        }),
      ),
    ),
  );

describe("ConnectionDriver routes another environment answers", () => {
  it.effect("reads a descriptor naming another environment as elsewhere", () =>
    Effect.gen(function* () {
      const driver = yield* driverWith(answeredBy("environment-other"), []);
      const lanRoute = { target: LAN_THEN_RELAY.target, profile: LAN_THEN_RELAY.profile };
      expect(yield* driver.checkRoute(LAN_THEN_RELAY, lanRoute)).toBe("elsewhere");
    }),
  );

  it.effect("never prepares, and so never sends a credential to, that route", () =>
    Effect.gen(function* () {
      const prepared: Array<ConnectionTarget> = [];
      const driver = yield* driverWith(answeredBy("environment-other"), prepared);
      yield* driver.connect(LAN_THEN_RELAY, () => Effect.void).pipe(Effect.scoped, Effect.exit);
      expect(prepared.map((target) => target._tag)).toEqual(["RelayConnectionTarget"]);
    }),
  );
});
