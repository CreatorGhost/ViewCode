import { describe, expect, it } from "@effect/vitest";
import type { ViewCodeRelaySetupState } from "@t3tools/contracts";
import type { RelayProbeOutcome, RelayState } from "@t3tools/shared/viewcodeRelaySetup";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeRelaySetup, type RelaySetupDeps, type RelaySetupStore } from "./ViewCodeRelaySetup.ts";
import type { WranglerResult, WranglerSession } from "./wranglerRunner.ts";

const WORKER_URL = "https://viewcode-relay.me.workers.dev";
const DEPLOYED: WranglerResult = {
  exitCode: 0,
  output: `Uploaded viewcode-relay (2.1 sec)\nDeployed viewcode-relay triggers (0.4 sec)\n  ${WORKER_URL}\n`,
};
const NO_SUBDOMAIN: WranglerResult = {
  exitCode: 1,
  output:
    "✘ [ERROR] You need to register a workers.dev subdomain before publishing to workers.dev\n",
};
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** The body of the claim request. */
const decodeClaim = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ subdomain: Schema.String })),
);

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** What wrangler prints when it declines to register a subdomain non-interactively. */
const NO_SUBDOMAIN_FOR_ACCOUNT: WranglerResult = {
  exitCode: 1,
  output: `${NO_SUBDOMAIN.output}✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.json file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding\n`,
};
const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
/** `wrangler whoami --json` for a sign-in that reaches `accounts`. */
const whoamiJson = (accounts: ReadonlyArray<{ id: string; name: string }>): WranglerResult => ({
  exitCode: 0,
  output: toJson({ loggedIn: true, authType: "OAuth Token", email: "me@example.com", accounts }),
});
const CLOUDFLARE_TOKEN = "cloudflare-oauth-token-value";
const AUTH_TOKEN: WranglerResult = {
  exitCode: 0,
  output: toJson({ type: "oauth", token: CLOUDFLARE_TOKEN }),
};
const LOGIN_PROMPT =
  "To authorize Wrangler, please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  WDJB-MJHT\n\n";

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly input: string | undefined;
  readonly accountId: string | undefined;
}

/**
 * A scripted wrangler: `results[command]` is consumed in order, the last one
 * repeating. `login` prints the device prompt, then waits for `approve`.
 */
const makeFakeWrangler = (results: Record<string, ReadonlyArray<WranglerResult>>) =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const approve = yield* Deferred.make<void>();
    const counters = new Map<string, number>();
    const session: WranglerSession = {
      configPath: "/tmp/staged/wrangler.json",
      run: (args, options) =>
        Effect.gen(function* () {
          calls.push({ args, input: options?.input, accountId: options?.accountId });
          // `whoami --json` and `auth token --json` are scripted by their full command line.
          const command = results[args.join(" ")] === undefined ? (args[0] ?? "") : args.join(" ");
          if (command === "login") {
            options?.onOutput?.(LOGIN_PROMPT);
            yield* Deferred.await(approve);
            return { exitCode: 0, output: `${LOGIN_PROMPT}Successfully logged in.` };
          }
          const scripted = results[command] ?? [{ exitCode: 0, output: "" }];
          const index = counters.get(command) ?? 0;
          counters.set(command, index + 1);
          return scripted[Math.min(index, scripted.length - 1)]!;
        }),
    };
    return { session, calls, approve };
  });

const makeMemoryStore = (initial: {
  readonly secret?: string;
  readonly relay?: RelayState;
  readonly url?: string;
  readonly enabled?: boolean;
}) => {
  const data = {
    secret: initial.secret ?? null,
    relay: initial.relay ?? null,
    url: initial.url ?? null,
    enabled: initial.enabled ?? false,
  };
  const store: RelaySetupStore = {
    readSecret: Effect.sync(() => data.secret),
    writeSecret: (secret) => Effect.sync(() => void (data.secret = secret)),
    removeSecret: Effect.sync(() => void (data.secret = null)),
    readRelayState: Effect.sync(() => data.relay),
    writeRelayState: (relay) => Effect.sync(() => void (data.relay = relay)),
    removeRelayState: Effect.sync(() => void (data.relay = null)),
    readRelayUrl: Effect.sync(() => data.url),
    saveRelaySettings: (patch) =>
      Effect.sync(() => {
        if (patch.enabled !== undefined) data.enabled = patch.enabled;
        if (patch.url !== undefined) data.url = patch.url;
      }),
  };
  return { store, data };
};

/** Answers from `outcomes` in order, the last repeating; records what was probed. */
const makeProbe = (outcomes: ReadonlyArray<RelayProbeOutcome>) => {
  const probed: Array<{ origin: string; secret: string }> = [];
  return {
    probed,
    probe: (origin: string, secret: string) =>
      Effect.sync(() => {
        probed.push({ origin, secret });
        return outcomes[Math.min(probed.length - 1, outcomes.length - 1)]!;
      }),
  };
};

interface CloudflareRequest {
  readonly method: string;
  /** Below `/client/v4`. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string | undefined;
}

type CloudflareAnswer = { readonly status: number; readonly body: unknown };
const cloudflareOk = (result: unknown): CloudflareAnswer => ({
  status: 200,
  body: { success: true, errors: [], messages: [], result },
});
const cloudflareError = (status: number, code: number, message: string): CloudflareAnswer => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

/** The Cloudflare API: `respond` answers each request, which is recorded. */
const makeFakeCloudflare = (
  respond: (request: CloudflareRequest) => CloudflareAnswer | Effect.Effect<CloudflareAnswer>,
) => {
  const requests: CloudflareRequest[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const recorded: CloudflareRequest = {
        method: request.method,
        path: url.pathname.replace(/^\/client\/v4/u, ""),
        authorization: request.headers.authorization,
        body: request.body._tag === "Uint8Array" ? request.body.text : undefined,
      };
      requests.push(recorded);
      const answer = respond(recorded);
      const { status, body } = Effect.isEffect(answer) ? yield* answer : answer;
      return HttpClientResponse.fromWeb(
        request,
        new Response(toJson(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return { http, requests };
};

/** Answers a new account: no subdomain yet, every name free, the claim accepted. */
const freshAccount =
  (overrides: (request: CloudflareRequest) => CloudflareAnswer | undefined = () => undefined) =>
  (request: CloudflareRequest): CloudflareAnswer => {
    const overridden = overrides(request);
    if (overridden !== undefined) return overridden;
    if (request.method === "GET" && request.path === `/accounts/${ACCOUNT_ID}/workers/subdomain`)
      return cloudflareError(404, 10007, "This account does not have a workers.dev subdomain.");
    if (request.method === "GET" && request.path.includes("/workers/subdomains/"))
      return cloudflareError(404, 10032, "Subdomain is available.");
    if (request.method === "PUT") {
      const { subdomain } = decodeClaim(request.body);
      return cloudflareOk({ subdomain });
    }
    return cloudflareError(500, 0, "unexpected request");
  };

const noCloudflare = HttpClient.make(() => Effect.die("no Cloudflare API call expected"));

const makeSetup = (
  deps: Omit<RelaySetupDeps, "http"> & { readonly http?: HttpClient.HttpClient },
) => makeRelaySetup({ http: noCloudflare, ...deps });

const captureLogs = () => {
  const lines: string[] = [];
  const logger = Logger.make<unknown, void>((options) => {
    lines.push(toJson(options.message));
  });
  return { lines, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const ok: RelayProbeOutcome = { kind: "ok" };
const reset: RelayProbeOutcome = {
  kind: "problem",
  problem: "network-refused",
  detail: "ECONNRESET",
};
const rejected: RelayProbeOutcome = {
  kind: "problem",
  problem: "credential-rejected",
  detail: "The relay answered 401.",
};

const isSettled = (state: ViewCodeRelaySetupState) => state.status !== "running";

/** Waits for the first state matching `predicate`, however many changes that takes. */
const awaitState = (
  changes: Stream.Stream<ViewCodeRelaySetupState>,
  predicate: (state: ViewCodeRelaySetupState) => boolean,
) => changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

describe("ViewCodeRelaySetup", () => {
  it.effect("signs in with the device flow, deploys, stores the secret and verifies", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [
          { exitCode: 0, output: "You are not authenticated. Please run `wrangler login`." },
        ],
        deploy: [DEPLOYED],
      });
      const { store, data } = makeMemoryStore({});
      const { probe, probed } = makeProbe([ok]);
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe,
      });

      yield* setup.start({ mode: "new" });
      const signingIn = yield* awaitState(
        setup.changes,
        (state) => state.signIn?.code !== undefined,
      );
      expect(signingIn.step).toBe("signing-in");
      expect(signingIn.signIn).toMatchObject({
        url: "https://dash.cloudflare.com/oauth2/device",
        code: "WDJB-MJHT",
        openUrl: "https://dash.cloudflare.com/oauth2/device?user_code=WDJB-MJHT",
      });
      // Nothing is deployed before the person approves.
      expect(wrangler.calls.map((call) => call.args[0])).toEqual(["whoami", "login"]);
      expect(wrangler.calls[1]!.args).toEqual(["login", "--device", "--browser=false"]);

      yield* Deferred.succeed(wrangler.approve, undefined);
      const done = yield* awaitState(setup.changes, isSettled);

      expect(done).toEqual({ status: "succeeded", message: "Quick connect is set up." });
      expect(data).toMatchObject({ url: WORKER_URL, enabled: true });
      expect(data.relay).toEqual({ name: "viewcode-relay", url: WORKER_URL });
      const secret = data.secret!;
      expect(secret.length).toBeGreaterThanOrEqual(40);
      const put = wrangler.calls.find((call) => call.args[0] === "secret")!;
      // The secret travels on stdin only.
      expect(put.input).toBe(`${secret}\n`);
      expect(wrangler.calls.some((call) => call.args.some((arg) => arg.includes(secret)))).toBe(
        false,
      );
      expect(probed).toEqual([{ origin: WORKER_URL, secret }]);
    }),
  );

  it.effect("creates a missing workers.dev subdomain itself, then deploys again", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in with an OAuth Token." }],
        deploy: [NO_SUBDOMAIN_FOR_ACCOUNT, DEPLOYED],
        "auth token --json": [AUTH_TOKEN],
      });
      const claimGate = yield* Deferred.make<void>();
      const cloudflare = makeFakeCloudflare((request) => {
        const answer = freshAccount()(request);
        return request.method === "PUT"
          ? Deferred.await(claimGate).pipe(Effect.as(answer))
          : answer;
      });
      const { store, data } = makeMemoryStore({});
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
        http: cloudflare.http,
      });

      yield* setup.start({ mode: "new" });
      const creating = yield* awaitState(
        setup.changes,
        (state) => state.message === "Creating your free workers.dev address…",
      );
      expect(creating).toMatchObject({ status: "running", step: "deploying" });
      yield* Deferred.succeed(claimGate, undefined);
      const done = yield* awaitState(setup.changes, isSettled);

      expect(done).toEqual({ status: "succeeded", message: "Quick connect is set up." });
      expect(data.url).toBe(WORKER_URL);
      expect(wrangler.calls.map((call) => call.args.join(" ").split(" --")[0])).toEqual([
        "whoami",
        "whoami",
        "deploy",
        "auth token",
        "deploy",
        "secret put HOST_SECRET",
      ]);
      const workers = `/accounts/${ACCOUNT_ID}/workers`;
      const [current, check, claim] = cloudflare.requests;
      expect(cloudflare.requests).toHaveLength(3);
      expect(current).toMatchObject({ method: "GET", path: `${workers}/subdomain` });
      expect(check!.path).toMatch(new RegExp(`^${workers}/subdomains/viewcode-[a-z0-9]{6}$`, "u"));
      const name = check!.path.split("/").at(-1)!;
      expect(claim).toMatchObject({ method: "PUT", path: `${workers}/subdomain` });
      expect(decodeClaim(claim!.body)).toEqual({ subdomain: name });
      expect(
        cloudflare.requests.every(
          (request) => request.authorization === `Bearer ${CLOUDFLARE_TOKEN}`,
        ),
      ).toBe(true);
    }),
  );

  it.effect("tries another name when the first one is taken", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        deploy: [NO_SUBDOMAIN_FOR_ACCOUNT, DEPLOYED],
        "auth token --json": [AUTH_TOKEN],
      });
      let checks = 0;
      const cloudflare = makeFakeCloudflare(
        freshAccount((request) =>
          request.path.includes("/workers/subdomains/") && (checks += 1) === 1
            ? cloudflareError(409, 10031, "Subdomain is unavailable.")
            : undefined,
        ),
      );
      const { store } = makeMemoryStore({});
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
        http: cloudflare.http,
      });

      yield* setup.start({ mode: "new" });
      const done = yield* awaitState(setup.changes, isSettled);
      expect(done.status).toBe("succeeded");
      expect(cloudflare.requests.map((request) => request.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "PUT",
      ]);
      const [, taken, free, claim] = cloudflare.requests;
      expect(taken!.path).not.toBe(free!.path);
      expect(decodeClaim(claim!.body)).toEqual({ subdomain: free!.path.split("/").at(-1) });
    }),
  );

  it.effect(
    "asks for a workers.dev subdomain when Cloudflare refuses, without leaking the token",
    () => {
      const logs = captureLogs();
      return Effect.gen(function* () {
        const wrangler = yield* makeFakeWrangler({
          whoami: [{ exitCode: 0, output: "You are logged in." }],
          deploy: [NO_SUBDOMAIN_FOR_ACCOUNT, DEPLOYED],
          "auth token --json": [AUTH_TOKEN],
        });
        const cloudflare = makeFakeCloudflare(() =>
          cloudflareError(403, 10000, `Authentication error for ${CLOUDFLARE_TOKEN}`),
        );
        const { store, data } = makeMemoryStore({});
        const setup = yield* makeSetup({
          prepare: () => Effect.succeed(wrangler.session),
          store,
          probe: makeProbe([ok]).probe,
          http: cloudflare.http,
        });

        yield* setup.start({ mode: "new" });
        const stopped = yield* awaitState(setup.changes, isSettled);
        expect(stopped.status).toBe("needs-subdomain");
        expect(stopped.message).toContain("Open Cloudflare");
        expect(stopped.details).toContain("Authentication error for [redacted] [code: 10000]");
        expect(toJson(stopped)).not.toContain(CLOUDFLARE_TOKEN);
        expect(logs.lines.join("\n")).not.toContain(CLOUDFLARE_TOKEN);
        // Nothing was saved for an address that does not exist.
        expect(data).toMatchObject({ url: null, secret: null, enabled: false });

        // The person picked one in the dashboard.
        yield* setup.continueSetup;
        const done = yield* awaitState(setup.changes, isSettled);
        expect(done.status).toBe("succeeded");
        expect(data.url).toBe(WORKER_URL);
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("uses the only Cloudflare account without asking and remembers it", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        "whoami --json": [whoamiJson([{ id: ACCOUNT_ID, name: "Personal" }])],
        deploy: [DEPLOYED],
      });
      const { store, data } = makeMemoryStore({});
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
      });

      yield* setup.start({ mode: "new" });
      const done = yield* awaitState(setup.changes, isSettled);
      expect(done.status).toBe("succeeded");
      expect(data.relay).toEqual({
        name: "viewcode-relay",
        url: WORKER_URL,
        accountId: ACCOUNT_ID,
      });
      const deploy = wrangler.calls.find((call) => call.args[0] === "deploy")!;
      expect(deploy.accountId).toBe(ACCOUNT_ID);
    }),
  );

  it.effect("asks which account to use when the sign-in has several, then deploys there", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        "whoami --json": [
          whoamiJson([
            { id: OTHER_ACCOUNT_ID, name: "Personal" },
            { id: ACCOUNT_ID, name: "Work" },
          ]),
        ],
        // No dashboard link to read the account from: only the choice says which.
        deploy: [NO_SUBDOMAIN, DEPLOYED],
        "auth token --json": [AUTH_TOKEN],
      });
      const cloudflare = makeFakeCloudflare(freshAccount());
      const { store, data } = makeMemoryStore({});
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
        http: cloudflare.http,
      });

      yield* setup.start({ mode: "new" });
      const asked = yield* awaitState(setup.changes, isSettled);
      expect(asked.status).toBe("needs-account");
      expect(asked.accounts).toEqual([
        { id: OTHER_ACCOUNT_ID, name: "Personal" },
        { id: ACCOUNT_ID, name: "Work" },
      ]);
      // Nothing was deployed or read for an account nobody chose.
      expect(wrangler.calls.map((call) => call.args.join(" "))).toEqual([
        "whoami",
        "whoami --json",
      ]);

      const unknown = yield* setup
        .chooseAccount("ffffffffffffffffffffffffffffffff")
        .pipe(Effect.flip);
      expect(unknown.detail).toContain("not one of the choices");

      const before = wrangler.calls.length;
      yield* setup.chooseAccount(ACCOUNT_ID);
      const done = yield* awaitState(setup.changes, isSettled);
      expect(done.status).toBe("succeeded");
      const after = wrangler.calls.slice(before).filter((call) => call.args[0] !== "whoami");
      expect(after.map((call) => call.args[0])).toEqual(["deploy", "auth", "deploy", "secret"]);
      expect(after.every((call) => call.accountId === ACCOUNT_ID)).toBe(true);
      // The workers.dev address went to the chosen account, not a guess.
      expect(
        cloudflare.requests.every((request) =>
          request.path.startsWith(`/accounts/${ACCOUNT_ID}/workers`),
        ),
      ).toBe(true);
      expect(data.relay).toEqual({
        name: "viewcode-relay",
        url: WORKER_URL,
        accountId: ACCOUNT_ID,
      });
    }),
  );

  it.effect("redeploy and remove reuse the remembered account; a vanished one is asked again", () =>
    Effect.gen(function* () {
      const relay = { name: "viewcode-relay", url: WORKER_URL, accountId: ACCOUNT_ID };
      const both = whoamiJson([
        { id: OTHER_ACCOUNT_ID, name: "Personal" },
        { id: ACCOUNT_ID, name: "Work" },
      ]);
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        "whoami --json": [both],
        deploy: [DEPLOYED],
        delete: [{ exitCode: 0, output: "Successfully deleted viewcode-relay" }],
      });
      const { store, data } = makeMemoryStore({
        secret: "stored-secret-value",
        relay,
        url: WORKER_URL,
        enabled: true,
      });
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
      });

      yield* setup.start({ mode: "redeploy", rotateSecret: true });
      const redeployed = yield* awaitState(setup.changes, isSettled);
      expect(redeployed.status).toBe("succeeded");
      const deploy = wrangler.calls.find((call) => call.args[0] === "deploy")!;
      expect(deploy.accountId).toBe(ACCOUNT_ID);
      expect(wrangler.calls.find((call) => call.args[0] === "secret")!.accountId).toBe(ACCOUNT_ID);
      expect(data.relay).toEqual(relay);

      yield* setup.remove({});
      const removed = yield* awaitState(setup.changes, isSettled);
      expect(removed.status).toBe("idle");
      expect(wrangler.calls.find((call) => call.args[0] === "delete")!.accountId).toBe(ACCOUNT_ID);

      // The sign-in no longer reaches the remembered account.
      const gone = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        "whoami --json": [
          whoamiJson([
            { id: OTHER_ACCOUNT_ID, name: "Personal" },
            { id: "fedcba9876543210fedcba9876543211", name: "Side" },
          ]),
        ],
      });
      const later = makeMemoryStore({ secret: "stored-secret-value", relay, url: WORKER_URL });
      const again = yield* makeSetup({
        prepare: () => Effect.succeed(gone.session),
        store: later.store,
        probe: makeProbe([ok]).probe,
      });
      yield* again.start({ mode: "redeploy" });
      const asked = yield* awaitState(again.changes, isSettled);
      expect(asked.status).toBe("needs-account");
      expect(gone.calls.some((call) => call.args[0] === "deploy")).toBe(false);
    }),
  );

  it.effect(
    "a failure after the subdomain was created keeps the token out of the state and logs",
    () => {
      const logs = captureLogs();
      return Effect.gen(function* () {
        const wrangler = yield* makeFakeWrangler({
          whoami: [{ exitCode: 0, output: "You are logged in." }],
          deploy: [
            NO_SUBDOMAIN_FOR_ACCOUNT,
            { exitCode: 1, output: `✘ [ERROR] Authentication error with ${CLOUDFLARE_TOKEN}` },
          ],
          "auth token --json": [AUTH_TOKEN],
        });
        const cloudflare = makeFakeCloudflare(freshAccount());
        const { store } = makeMemoryStore({});
        const setup = yield* makeSetup({
          prepare: () => Effect.succeed(wrangler.session),
          store,
          probe: makeProbe([ok]).probe,
          http: cloudflare.http,
        });

        yield* setup.start({ mode: "new" });
        const failed = yield* awaitState(setup.changes, isSettled);
        expect(failed.status).toBe("failed");
        expect(failed.details).toContain("Authentication error with [redacted]");
        expect(toJson(failed)).not.toContain(CLOUDFLARE_TOKEN);
        expect(logs.lines.some((line) => line.includes("Quick connect setup stopped"))).toBe(true);
        expect(logs.lines.join("\n")).not.toContain(CLOUDFLARE_TOKEN);
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("keeps verifying through network resets until the address answers", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        deploy: [DEPLOYED],
      });
      const { store } = makeMemoryStore({});
      const { probe, probed } = makeProbe([reset, reset, reset, ok]);
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe,
      });

      yield* setup.start({ mode: "new" });
      const waiting = yield* awaitState(setup.changes, (state) => state.problem !== undefined);
      expect(waiting).toMatchObject({
        status: "running",
        step: "verifying",
        problem: "network-refused",
      });
      expect(waiting.message).toContain("Waiting for your network");

      const settled = yield* awaitState(setup.changes, isSettled).pipe(Effect.forkChild);
      // 5s, 10s, 20s between the attempts.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* TestClock.adjust(Duration.seconds(10));
      yield* TestClock.adjust(Duration.seconds(20));
      const done = yield* Fiber.join(settled);
      expect(done.status).toBe("succeeded");
      expect(probed).toHaveLength(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports unreachable after the retry window and keeps the saved settings", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        deploy: [DEPLOYED],
      });
      const { store, data } = makeMemoryStore({});
      const { probe } = makeProbe([reset]);
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe,
      });

      yield* setup.start({ mode: "new" });
      const settled = yield* awaitState(setup.changes, isSettled).pipe(Effect.forkChild);
      yield* awaitState(setup.changes, (state) => state.problem !== undefined);
      for (let minute = 0; minute < 12; minute += 1) yield* TestClock.adjust(Duration.minutes(1));
      const done = yield* Fiber.join(settled);
      expect(done).toMatchObject({ status: "unreachable", problem: "network-refused" });
      expect(data).toMatchObject({ url: WORKER_URL, enabled: true });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("tells a rejected secret apart from a blocked network", () =>
    Effect.gen(function* () {
      const { store } = makeMemoryStore({ secret: "stored-secret-value", url: WORKER_URL });
      const { probe } = makeProbe([rejected]);
      const setup = yield* makeSetup({
        prepare: () => Effect.die("reuse needs no wrangler"),
        store,
        probe,
      });
      yield* setup.start({ mode: "reuse" });
      const settled = yield* awaitState(setup.changes, isSettled).pipe(Effect.forkChild);
      yield* awaitState(setup.changes, (state) => state.problem !== undefined);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* TestClock.adjust(Duration.seconds(10));
      const done = yield* Fiber.join(settled);
      expect(done).toMatchObject({ status: "unreachable", problem: "credential-rejected" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reuse verifies and turns on the stored relay without deploying", () =>
    Effect.gen(function* () {
      const { store, data } = makeMemoryStore({
        secret: "stored-secret-value",
        url: WORKER_URL,
        relay: { name: "viewcode-relay", url: WORKER_URL },
        enabled: false,
      });
      const { probe, probed } = makeProbe([ok]);
      const setup = yield* makeSetup({
        prepare: () => Effect.die("reuse needs no wrangler"),
        store,
        probe,
      });
      yield* setup.start({ mode: "reuse" });
      const done = yield* awaitState(setup.changes, isSettled);
      expect(done.status).toBe("succeeded");
      expect(data).toMatchObject({ enabled: true, secret: "stored-secret-value" });
      expect(probed).toEqual([{ origin: WORKER_URL, secret: "stored-secret-value" }]);
    }),
  );

  it.effect("redeploy keeps the secret unless rotation is asked for", () =>
    Effect.gen(function* () {
      const relay = { name: "my-relay", url: "https://my-relay.me.workers.dev" };
      const deployed: WranglerResult = { exitCode: 0, output: `Deployed\n  ${relay.url}\n` };
      const run = (rotateSecret: boolean) =>
        Effect.gen(function* () {
          const wrangler = yield* makeFakeWrangler({
            whoami: [{ exitCode: 0, output: "You are logged in." }],
            deploy: [deployed],
          });
          const { store, data } = makeMemoryStore({ secret: "stored-secret-value", relay });
          const setup = yield* makeSetup({
            prepare: () => Effect.succeed(wrangler.session),
            store,
            probe: makeProbe([ok]).probe,
          });
          yield* setup.start({ mode: "redeploy", rotateSecret });
          yield* awaitState(setup.changes, isSettled);
          const deploy = wrangler.calls.find((call) => call.args[0] === "deploy")!;
          return { data, deploy };
        });

      const kept = yield* run(false);
      expect(kept.data.secret).toBe("stored-secret-value");
      // Same Worker name, so the address does not change.
      expect(kept.deploy.args).toContain("my-relay");

      const rotated = yield* run(true);
      expect(rotated.data.secret).not.toBe("stored-secret-value");
    }),
  );

  it.effect("remove deletes the Worker, then clears the secret, state and settings", () =>
    Effect.gen(function* () {
      const relay = { name: "viewcode-relay", url: WORKER_URL };
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        delete: [{ exitCode: 0, output: "Successfully deleted viewcode-relay" }],
      });
      const { store, data } = makeMemoryStore({
        secret: "stored-secret-value",
        relay,
        url: WORKER_URL,
        enabled: true,
      });
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
      });
      yield* setup.remove({});
      const done = yield* awaitState(setup.changes, isSettled);
      expect(done).toEqual({ status: "idle", message: "Quick connect is removed." });
      expect(wrangler.calls.find((call) => call.args[0] === "delete")!.args).toEqual([
        "delete",
        "--name",
        "viewcode-relay",
        "--config",
        "/tmp/staged/wrangler.json",
        "--force",
      ]);
      expect(data).toEqual({ secret: null, relay: null, url: null, enabled: false });
    }),
  );

  it.effect("a failed delete changes nothing locally, and local-only removal still works", () =>
    Effect.gen(function* () {
      const relay = { name: "viewcode-relay", url: WORKER_URL };
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 0, output: "You are logged in." }],
        delete: [{ exitCode: 1, output: "Authentication error [code: 10000] stored-secret-value" }],
      });
      const { store, data } = makeMemoryStore({
        secret: "stored-secret-value",
        relay,
        url: WORKER_URL,
        enabled: true,
      });
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
      });
      yield* setup.remove({});
      const failed = yield* awaitState(setup.changes, isSettled);
      expect(failed.status).toBe("remove-failed");
      expect(failed.details).toContain("Authentication error");
      // Output is redacted before it reaches the client.
      expect(failed.details).not.toContain("stored-secret-value");
      expect(data).toMatchObject({ secret: "stored-secret-value", url: WORKER_URL });

      yield* setup.remove({ localOnly: true });
      const cleared = yield* awaitState(setup.changes, (state) => state.status === "idle");
      expect(cleared.message).toContain("still on your Cloudflare account");
      expect(data).toEqual({ secret: null, relay: null, url: null, enabled: false });
    }),
  );

  it.effect("only one operation runs at a time, and cancel stops it", () =>
    Effect.gen(function* () {
      const wrangler = yield* makeFakeWrangler({
        whoami: [{ exitCode: 1, output: "You are not authenticated." }],
      });
      const { store, data } = makeMemoryStore({});
      const setup = yield* makeSetup({
        prepare: () => Effect.succeed(wrangler.session),
        store,
        probe: makeProbe([ok]).probe,
      });
      yield* setup.start({ mode: "new" });
      yield* awaitState(setup.changes, (state) => state.signIn?.code !== undefined);
      const second = yield* setup.start({ mode: "new" }).pipe(Effect.flip);
      expect(second.detail).toContain("already running");

      yield* setup.cancel;
      expect(yield* setup.current).toEqual({ status: "idle", message: "Setup cancelled." });
      expect(data).toMatchObject({ url: null, secret: null });
    }),
  );

  it.effect("a live relay connection ends verification that this network keeps refusing", () =>
    Effect.gen(function* () {
      const { store } = makeMemoryStore({ secret: "stored-secret-value", url: WORKER_URL });
      const setup = yield* makeSetup({
        prepare: () => Effect.die("reuse needs no wrangler"),
        store,
        probe: makeProbe([reset]).probe,
      });
      yield* setup.start({ mode: "reuse" });
      yield* awaitState(setup.changes, (state) => state.problem === "network-refused");
      yield* setup.relayConnected;
      expect(yield* setup.current).toEqual({
        status: "succeeded",
        message: "Quick connect is set up.",
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
