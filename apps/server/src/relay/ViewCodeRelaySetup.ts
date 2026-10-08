/**
 * ViewCode Quick connect setup from the app: signs in to the person's own
 * Cloudflare account (wrangler's device flow, whose link and code the UI
 * shows), asks which account when the sign-in has several, deploys the relay
 * Worker, stores the host secret and verifies the address answers before
 * calling it done. Also removes it again.
 *
 * One operation runs at a time, forked into the service's scope, so closing
 * the dialog does not stop it. Progress is a `ViewCodeRelaySetupState` the
 * server pushes on the auth access stream beside the connection's own
 * `ViewCodeRelayState`. The steps depend only on `RelaySetupDeps`, so tests
 * drive them with a fake wrangler and probe.
 *
 * Secrets: the host secret reaches wrangler only on stdin; every piece of
 * wrangler output is redacted before it is kept or shown, and none is logged.
 * Wrangler's Cloudflare token, read only to create a missing workers.dev
 * subdomain, stays in memory and is redacted the same way.
 */
import {
  type ViewCodeRelayProblem,
  ViewCodeRelaySetupError,
  type ViewCodeRelaySetupStartInput,
  type ViewCodeRelaySetupState,
  type ViewCodeRelaySetupStep,
} from "@t3tools/contracts";
import { RELAY_HOST_PATH, RELAY_HOST_SECRET_NAME } from "@t3tools/shared/viewcodeRelayProtocol";
import {
  classifyProbeError,
  classifyProbeStatus,
  DEFAULT_WORKER_NAME,
  describeFetchError,
  detectMissingWorkersDevSubdomain,
  detectWorkerAlreadyDeleted,
  deviceLoginOpenUrl,
  generateHostSecret,
  isValidWorkerName,
  parseDeviceLoginPrompt,
  parseRelayState,
  parseWorkerUrl,
  redactSecrets,
  RELAY_STATE_FILE,
  type RelayProbeOutcome,
  type RelayState,
  stripAnsi,
  wranglerNeedsLogin,
} from "@t3tools/shared/viewcodeRelaySetup";
import * as Undici from "@effect/platform-node/Undici";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  prepareNodeWrangler,
  RelaySetupFailure,
  type WranglerResult,
  type WranglerSession,
} from "./wranglerRunner.ts";
import {
  parseDeployAccountId,
  parseWhoamiAccounts,
  parseWranglerAuthToken,
  registerWorkersDevSubdomain,
} from "./workersDevSubdomain.ts";

/** Where setup keeps what it needs across restarts. Failures are plain sentences. */
export interface RelaySetupStore {
  readonly readSecret: Effect.Effect<string | null>;
  readonly writeSecret: (secret: string) => Effect.Effect<void, RelaySetupFailure>;
  readonly removeSecret: Effect.Effect<void, RelaySetupFailure>;
  /**
   * The deployed Worker's name, address and Cloudflare account
   * (`viewcode-relay.json`), for redeploy and remove.
   */
  readonly readRelayState: Effect.Effect<RelayState | null>;
  readonly writeRelayState: (state: RelayState) => Effect.Effect<void, RelaySetupFailure>;
  readonly removeRelayState: Effect.Effect<void, RelaySetupFailure>;
  /** `viewcodeRelay.url` in settings. */
  readonly readRelayUrl: Effect.Effect<string | null>;
  /** `url: null` clears the address. The connector follows every change. */
  readonly saveRelaySettings: (patch: {
    readonly enabled?: boolean;
    readonly url?: string | null;
  }) => Effect.Effect<void, RelaySetupFailure>;
}

/** One request to the relay with the host secret; never fails. */
export type ProbeRelay = (origin: string, secret: string) => Effect.Effect<RelayProbeOutcome>;

export interface RelaySetupDeps {
  readonly prepare: Effect.Effect<WranglerSession, RelaySetupFailure, Scope.Scope>;
  readonly store: RelaySetupStore;
  readonly probe: ProbeRelay;
  /** For the Cloudflare API calls that create a missing workers.dev subdomain. */
  readonly http: HttpClient.HttpClient;
}

/**
 * Seconds between verification attempts: quick at first, then once a minute,
 * about ten minutes in all. A fresh workers.dev hostname can be reset by a
 * corporate firewall for a while, so one reset is never the verdict.
 */
export const VERIFY_DELAYS_SECONDS = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60, 60, 60, 60] as const;
/** A just-stored Worker secret can take a moment to apply; 401s in a row before believing it. */
const CREDENTIAL_REJECTIONS_BEFORE_REPORTING = 3;
const DETAILS_MAX_CHARS = 16_000;
const SIGN_IN_LINES = 12;

const STEP_MESSAGE: Record<ViewCodeRelaySetupStep, string> = {
  "checking-tools": "Getting ready…",
  "signing-in": "Signing in to Cloudflare…",
  deploying: "Setting up your relay…",
  "storing-secret": "Securing it…",
  verifying: "Checking it works…",
  removing: "Removing Quick connect…",
};

export const WAITING_MESSAGE: Record<ViewCodeRelayProblem, string> = {
  "network-refused":
    "Waiting for your network to allow the new address. This can take a few minutes. You can close this; ViewCode keeps trying.",
  transient:
    "Waiting for the new address to come online. You can close this; ViewCode keeps trying.",
  "credential-rejected": "The relay has not accepted this computer's secret yet. Checking again…",
};

const UNREACHABLE_MESSAGE: Record<ViewCodeRelayProblem, string> = {
  "network-refused":
    "Your relay is set up, but this network still blocks its new address. ViewCode keeps trying and connects once it is allowed; Same Wi-Fi works meanwhile.",
  transient:
    "Your relay is set up, but its address is not answering yet. ViewCode keeps trying in the background.",
  "credential-rejected":
    "The relay does not accept this computer's secret. Redeploy with a new secret to fix it.",
};

const idleState: ViewCodeRelaySetupState = { status: "idle" };

export interface ViewCodeRelaySetupShape {
  /** The current state, then every change. */
  readonly changes: Stream.Stream<ViewCodeRelaySetupState>;
  readonly current: Effect.Effect<ViewCodeRelaySetupState>;
  readonly start: (
    input: ViewCodeRelaySetupStartInput,
  ) => Effect.Effect<void, ViewCodeRelaySetupError>;
  /**
   * Stops the running operation and the wrangler process it started, or
   * dismisses a finished one (a failure, a missing subdomain) back to idle.
   */
  readonly cancel: Effect.Effect<void>;
  /**
   * After the person created a workers.dev subdomain themselves (setup could
   * not create it): deploy again with the same options.
   */
  readonly continueSetup: Effect.Effect<void, ViewCodeRelaySetupError>;
  /** Answers `needs-account`: deploy again on this account, which is then remembered. */
  readonly chooseAccount: (accountId: string) => Effect.Effect<void, ViewCodeRelaySetupError>;
  readonly remove: (input: {
    readonly localOnly?: boolean | undefined;
  }) => Effect.Effect<void, ViewCodeRelaySetupError>;
  /**
   * The connector reached the relay: proof the setup works, even if this
   * computer's own probes were still being refused. Ends a verification early
   * and clears an "unreachable" verdict so it does not linger as a stale label.
   */
  readonly relayConnected: Effect.Effect<void>;
}

export class ViewCodeRelaySetup extends Context.Service<
  ViewCodeRelaySetup,
  ViewCodeRelaySetupShape
>()("t3/relay/ViewCodeRelaySetup") {}

type DeployOptions = {
  readonly mode: "new" | "redeploy";
  readonly rotateSecret: boolean;
  /** Chosen by the person after `needs-account`; wins over the remembered one. */
  readonly accountId?: string;
};

/** Every wrangler run of `session` acts on `accountId`; unchanged when it is unknown. */
const forAccount = (session: WranglerSession, accountId: string | null): WranglerSession =>
  accountId === null
    ? session
    : { ...session, run: (args, options) => session.run(args, { ...options, accountId }) };

export const makeRelaySetup = (deps: RelaySetupDeps) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ViewCodeRelaySetupState>(idleState);
    const handle = yield* FiberHandle.make<void, never>();
    /** What `continueSetup` and `chooseAccount` repeat. */
    let pending: DeployOptions | null = null;
    /** Secrets to redact from anything kept from this run's output. */
    let secrets: Array<string | null> = [];
    let details = "";

    const publish = (next: ViewCodeRelaySetupState) => SubscriptionRef.set(state, next);
    const withDetails = (next: ViewCodeRelaySetupState): ViewCodeRelaySetupState =>
      details === "" ? next : { ...next, details };
    const setStep = (step: ViewCodeRelaySetupStep, extra: Partial<ViewCodeRelaySetupState> = {}) =>
      publish(withDetails({ status: "running", step, message: STEP_MESSAGE[step], ...extra }));
    const redact = (text: string) => redactSecrets(stripAnsi(text), secrets);
    const appendDetails = (text: string) => {
      const kept = redact(text).trim();
      if (kept !== "")
        details = `${details}${details === "" ? "" : "\n\n"}${kept}`.slice(-DETAILS_MAX_CHARS);
    };
    const keep = (result: WranglerResult) => Effect.sync(() => appendDetails(result.output));
    const fail = (message: string) => new RelaySetupFailure({ message });

    /** Signs in with the device flow unless wrangler already has a login. */
    const signIn = (session: WranglerSession) =>
      Effect.gen(function* () {
        // The first wrangler run also downloads it, so this is still "getting ready".
        const whoami = yield* session.run(["whoami"]);
        if (!wranglerNeedsLogin(redact(whoami.output), whoami.exitCode)) return;
        yield* setStep("signing-in", { signIn: { lines: [] } });

        const chunks = yield* Queue.unbounded<string>();
        let printed = "";
        const showPrompt = Queue.take(chunks).pipe(
          Effect.flatMap((chunk) => {
            printed += chunk;
            const text = redact(printed);
            const prompt = parseDeviceLoginPrompt(text);
            const openUrl = deviceLoginOpenUrl(prompt);
            const lines = text
              .split("\n")
              .map((line) => line.trimEnd())
              .filter((line) => line.trim() !== "")
              .slice(-SIGN_IN_LINES);
            return setStep("signing-in", {
              signIn: {
                ...(prompt.url === null ? {} : { url: prompt.url }),
                ...(prompt.code === null ? {} : { code: prompt.code }),
                ...(openUrl === null ? {} : { openUrl }),
                lines,
              },
            });
          }),
          Effect.forever,
          Effect.forkChild,
        );
        const pump = yield* showPrompt;
        // `--browser=false`: the app shows the link and code (and the desktop app
        // opens it); wrangler opening a browser on the server's machine would be
        // wrong for a remote client. Completes once the person approves.
        const login = yield* session.run(["login", "--device", "--browser=false"], {
          onOutput: (text) => {
            Queue.offerUnsafe(chunks, text);
          },
        });
        yield* Fiber.interrupt(pump);
        yield* keep(login);
        if (login.exitCode !== 0) {
          return yield* fail("Cloudflare sign-in did not finish. Try again.");
        }
      });

    /**
     * The Cloudflare account to deploy to: `preferred` (just chosen, or
     * remembered) while the sign-in still reaches it, else the only one. With
     * several and none of them known, the person chooses. Wrangler itself
     * cannot ask when it runs non-interactively, and fails instead.
     */
    const resolveAccount = (session: WranglerSession, preferred: string | null) =>
      Effect.gen(function* () {
        const whoami = yield* session.run(["whoami", "--json"]);
        const accounts = whoami.exitCode === 0 ? parseWhoamiAccounts(whoami.output) : null;
        // Unreadable: deploy as before and let wrangler decide (or explain).
        if (accounts === null || accounts.length === 0) return { accountId: preferred };
        if (preferred !== null && accounts.some((account) => account.id === preferred)) {
          return { accountId: preferred };
        }
        if (accounts.length === 1) return { accountId: accounts[0]!.id };
        return { choices: accounts };
      });

    /**
     * Gives an account without a workers.dev subdomain one, so the person is
     * never sent to the dashboard to pick it. False, with the reason in the
     * details, when it cannot; setup then asks the person after all.
     */
    const createWorkersDevSubdomain = (
      session: WranglerSession,
      deployOutput: string,
      knownAccountId: string | null,
    ) =>
      Effect.gen(function* () {
        yield* setStep("deploying", { message: "Creating your free workers.dev address…" });
        const accountId = knownAccountId ?? parseDeployAccountId(deployOutput);
        if (accountId === null) {
          appendDetails("Could not tell which Cloudflare account needs the workers.dev address.");
          return false;
        }
        // This output is the Cloudflare sign-in itself, so it is never kept.
        const auth = yield* session.run(["auth", "token", "--json"]);
        const token = auth.exitCode === 0 ? parseWranglerAuthToken(auth.output) : null;
        if (token === null) {
          appendDetails("Could not read the Cloudflare sign-in to create the workers.dev address.");
          return false;
        }
        secrets = [...secrets, token];
        return yield* registerWorkersDevSubdomain({ accountId, token }).pipe(
          Effect.provideService(HttpClient.HttpClient, deps.http),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                appendDetails(`Could not create a workers.dev address. ${error.message}`);
                return false;
              }),
            onSuccess: (subdomain) =>
              Effect.sync(() => {
                appendDetails(`Created ${subdomain}.workers.dev for this account.`);
                return true;
              }),
          }),
        );
      });

    const verify = (url: string, secret: string) =>
      Effect.gen(function* () {
        yield* setStep("verifying");
        let rejections = 0;
        for (let attempt = 0; ; attempt += 1) {
          const outcome = yield* deps.probe(url, secret);
          if (outcome.kind === "ok") {
            yield* publish({ status: "succeeded", message: "Quick connect is set up." });
            return;
          }
          rejections = outcome.problem === "credential-rejected" ? rejections + 1 : 0;
          const delay = VERIFY_DELAYS_SECONDS[attempt];
          if (rejections >= CREDENTIAL_REJECTIONS_BEFORE_REPORTING || delay === undefined) {
            // Saved settings stay: the connector keeps retrying on its own.
            yield* publish(
              withDetails({
                status: "unreachable",
                problem: outcome.problem,
                message: UNREACHABLE_MESSAGE[outcome.problem],
              }),
            );
            return;
          }
          yield* setStep("verifying", {
            problem: outcome.problem,
            message: WAITING_MESSAGE[outcome.problem],
          });
          yield* Effect.sleep(Duration.seconds(delay));
        }
      });

    const deploy = (options: DeployOptions) =>
      Effect.gen(function* () {
        yield* setStep("checking-tools");
        const wrangler = yield* deps.prepare;
        const remembered = yield* deps.store.readRelayState;
        const name =
          remembered !== null && isValidWorkerName(remembered.name)
            ? remembered.name
            : DEFAULT_WORKER_NAME;
        const storedSecret = yield* deps.store.readSecret;
        secrets = [storedSecret];

        yield* signIn(wrangler);
        const account = yield* resolveAccount(
          wrangler,
          options.accountId ?? remembered?.accountId ?? null,
        );
        if ("choices" in account) {
          pending = options;
          yield* publish(
            withDetails({
              status: "needs-account",
              accounts: account.choices,
              message: "Your Cloudflare sign-in has several accounts. Choose one for the relay.",
            }),
          );
          return;
        }
        const { accountId } = account;
        const session = forAccount(wrangler, accountId);

        yield* setStep("deploying");
        const runDeploy = session
          .run(["deploy", "--config", session.configPath, "--name", name])
          .pipe(Effect.tap(keep));
        let deployed = yield* runDeploy;
        let url = parseWorkerUrl(deployed.output, name);
        // Checked before the exit code: without a subdomain wrangler may exit non-zero.
        if (url === null && detectMissingWorkersDevSubdomain(deployed.output)) {
          if (yield* createWorkersDevSubdomain(session, deployed.output, accountId)) {
            yield* setStep("deploying");
            deployed = yield* runDeploy;
            url = parseWorkerUrl(deployed.output, name);
          }
        }
        if (url === null && detectMissingWorkersDevSubdomain(deployed.output)) {
          pending = accountId === null ? options : { ...options, accountId };
          yield* publish(
            withDetails({
              status: "needs-subdomain",
              message:
                "Your Cloudflare account needs a free workers.dev address first. Open Cloudflare, choose one under Workers & Pages, then come back.",
            }),
          );
          return;
        }
        if (deployed.exitCode !== 0) {
          return yield* fail("Cloudflare did not accept the relay. Try again.");
        }
        if (url === null) {
          return yield* fail(
            "The relay was deployed, but Cloudflare did not report its address. Try again.",
          );
        }

        yield* setStep("storing-secret");
        // Rotating is only ever explicit: an unchanged secret keeps a working relay working.
        const secret = (options.rotateSecret ? null : storedSecret) ?? generateHostSecret();
        secrets = [...secrets, secret];
        const put = yield* session.run(
          ["secret", "put", "HOST_SECRET", "--name", name, "--config", session.configPath],
          { input: `${secret}\n` },
        );
        yield* keep(put);
        if (put.exitCode !== 0) {
          return yield* fail(
            "Could not store the relay's secret on Cloudflare. Nothing changed on this computer. Try again.",
          );
        }
        // Secret first: the settings write is what the connector reacts to. A Cancel
        // here must not leave the secret and the address out of step.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* deps.store.writeSecret(secret);
            yield* deps.store.writeRelayState({
              name,
              url,
              ...(accountId === null ? {} : { accountId }),
            });
            yield* deps.store.saveRelaySettings({ enabled: true, url });
          }),
        );

        yield* verify(url, secret);
      }).pipe(Effect.scoped);

    const reuse = Effect.gen(function* () {
      const url = yield* deps.store.readRelayUrl;
      const secret = yield* deps.store.readSecret;
      if (url === null || secret === null) {
        return yield* fail(
          "No relay is set up on this computer yet. Set up Quick connect instead.",
        );
      }
      secrets = [secret];
      yield* deps.store.saveRelaySettings({ enabled: true });
      yield* verify(url, secret);
    });

    const clearLocal = Effect.gen(function* () {
      yield* deps.store.saveRelaySettings({ enabled: false, url: null });
      yield* deps.store.removeSecret;
      yield* deps.store.removeRelayState;
    });

    const removeRelay = (localOnly: boolean) =>
      Effect.gen(function* () {
        const remembered = yield* deps.store.readRelayState;
        if (remembered !== null && !localOnly) {
          const deleted = yield* Effect.gen(function* () {
            yield* setStep("checking-tools");
            const wrangler = yield* deps.prepare;
            secrets = [yield* deps.store.readSecret];
            yield* signIn(wrangler);
            // A relay set up before the account was remembered relies on wrangler's own choice.
            const session = forAccount(wrangler, remembered.accountId ?? null);
            yield* setStep("removing");
            const result = yield* session.run([
              "delete",
              "--name",
              remembered.name,
              "--config",
              session.configPath,
              "--force",
            ]);
            yield* keep(result);
            return result.exitCode === 0 || detectWorkerAlreadyDeleted(result.output);
          }).pipe(
            Effect.scoped,
            Effect.catch((failure) =>
              Effect.sync(() => {
                appendDetails(failure.message);
                return false;
              }),
            ),
          );
          if (!deleted) {
            // Nothing local changed, so a retry can still find the Worker.
            yield* publish(
              withDetails({
                status: "remove-failed",
                message:
                  "Could not delete the relay from Cloudflare. Nothing changed on this computer. Try again, or remove it from this computer only.",
              }),
            );
            return;
          }
        }
        yield* setStep("removing");
        yield* clearLocal;
        yield* publish({
          status: "idle",
          message:
            remembered === null && !localOnly
              ? "Quick connect is removed from this computer. If you set up its relay elsewhere, delete it in the Cloudflare dashboard."
              : localOnly
                ? "Quick connect is removed from this computer. The relay is still on your Cloudflare account."
                : "Quick connect is removed.",
        });
      });

    /** Claims the single slot and forks `operation`; failures become the state. */
    const launch = (
      first: ViewCodeRelaySetupState,
      operation: Effect.Effect<void, RelaySetupFailure>,
    ) =>
      Effect.gen(function* () {
        const claimed = yield* SubscriptionRef.modify(state, (current) =>
          current.status === "running" ? [false, current] : [true, first],
        );
        if (!claimed) {
          return yield* new ViewCodeRelaySetupError({
            detail: "Quick connect setup is already running.",
          });
        }
        details = "";
        secrets = [];
        yield* FiberHandle.run(
          handle,
          operation.pipe(
            Effect.catch((failure) =>
              Effect.logWarning("Quick connect setup stopped", { reason: failure.message }).pipe(
                Effect.andThen(
                  publish(
                    withDetails({
                      status: "failed",
                      message: failure.message,
                      ...(failure.details === undefined
                        ? {}
                        : { details: redact(failure.details) }),
                      ...(failure.action === undefined ? {} : { action: failure.action }),
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
      });

    const start = (input: ViewCodeRelaySetupStartInput) => {
      if (input.mode === "reuse") {
        return launch(
          { status: "running", step: "verifying", message: STEP_MESSAGE.verifying },
          reuse,
        );
      }
      const options: DeployOptions = {
        mode: input.mode,
        rotateSecret: input.mode === "redeploy" && input.rotateSecret === true,
      };
      pending = null;
      return launch(
        { status: "running", step: "checking-tools", message: STEP_MESSAGE["checking-tools"] },
        deploy(options),
      );
    };

    const service: ViewCodeRelaySetupShape = {
      changes: SubscriptionRef.changes(state),
      current: SubscriptionRef.get(state),
      start,
      cancel: Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.status === "idle" || current.status === "succeeded") return;
        if (current.status !== "running") {
          pending = null;
          yield* publish(idleState);
          return;
        }
        yield* FiberHandle.clear(handle);
        yield* publish({
          status: "idle",
          message:
            current.step === "verifying"
              ? "Stopped checking. Quick connect stays set up and keeps trying to connect."
              : "Setup cancelled.",
        });
      }),
      continueSetup: Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const options = pending;
        if (current.status !== "needs-subdomain" || options === null) {
          return yield* new ViewCodeRelaySetupError({ detail: "There is no setup to continue." });
        }
        yield* launch(
          { status: "running", step: "checking-tools", message: STEP_MESSAGE["checking-tools"] },
          deploy(options),
        );
      }),
      chooseAccount: (accountId) =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const options = pending;
          if (current.status !== "needs-account" || options === null) {
            return yield* new ViewCodeRelaySetupError({ detail: "There is no setup to continue." });
          }
          if (!current.accounts?.some((account) => account.id === accountId)) {
            return yield* new ViewCodeRelaySetupError({
              detail: "That Cloudflare account is not one of the choices.",
            });
          }
          yield* launch(
            { status: "running", step: "checking-tools", message: STEP_MESSAGE["checking-tools"] },
            deploy({ ...options, accountId }),
          );
        }),
      relayConnected: Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.status === "unreachable") {
          yield* publish(idleState);
        } else if (current.status === "running" && current.step === "verifying") {
          yield* FiberHandle.clear(handle);
          yield* publish({ status: "succeeded", message: "Quick connect is set up." });
        }
      }),
      remove: (input) =>
        launch(
          { status: "running", step: "removing", message: STEP_MESSAGE.removing },
          removeRelay(input.localOnly === true),
        ),
    };
    return service;
  });

// --- real dependencies ------------------------------------------------------------

const PROBE_TIMEOUT = Duration.seconds(10);

/** `GET /__viewcode/host` with the secret: 426 means the Worker has it and answers. */
export const probeRelay: ProbeRelay = (origin, secret) =>
  Effect.tryPromise({
    try: (signal) =>
      Undici.fetch(`${origin}${RELAY_HOST_PATH}`, {
        headers: { authorization: `Bearer ${secret}` },
        redirect: "manual",
        signal,
      }),
    catch: (cause) => describeFetchError(cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () => Effect.fail("ETIMEDOUT: no answer within 10s"),
    }),
    Effect.match({
      onFailure: classifyProbeError,
      onSuccess: (response) => {
        void response.body?.cancel().catch(() => undefined);
        return classifyProbeStatus(response.status);
      },
    }),
  );

export const layer = Layer.effect(
  ViewCodeRelaySetup,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const settings = yield* ServerSettings.ServerSettingsService;
    const http = yield* HttpClient.HttpClient;
    const relayStatePath = path.join(config.stateDir, RELAY_STATE_FILE);
    const storeFailure = (message: string) => () => new RelaySetupFailure({ message });

    const store: RelaySetupStore = {
      readSecret: secretStore.get(RELAY_HOST_SECRET_NAME).pipe(
        Effect.map((bytes) => {
          const value = Option.isSome(bytes) ? new TextDecoder().decode(bytes.value).trim() : "";
          return value === "" ? null : value;
        }),
        Effect.orElseSucceed(() => null),
      ),
      writeSecret: (secret) =>
        secretStore
          .set(RELAY_HOST_SECRET_NAME, new TextEncoder().encode(secret))
          .pipe(
            Effect.mapError(storeFailure("Could not save the relay's secret on this computer.")),
          ),
      removeSecret: secretStore
        .remove(RELAY_HOST_SECRET_NAME)
        .pipe(
          Effect.mapError(storeFailure("Could not remove the relay's secret from this computer.")),
        ),
      readRelayState: fs.readFileString(relayStatePath).pipe(
        Effect.map(parseRelayState),
        Effect.orElseSucceed(() => null),
      ),
      writeRelayState: (relay) =>
        fs
          .writeFileString(relayStatePath, `${JSON.stringify(relay)}\n`, { mode: 0o600 })
          .pipe(
            Effect.mapError(storeFailure("Could not save the relay's address on this computer.")),
          ),
      removeRelayState: fs
        .remove(relayStatePath, { force: true })
        .pipe(
          Effect.mapError(storeFailure("Could not remove the relay's address from this computer.")),
        ),
      readRelayUrl: settings.getSettings.pipe(
        Effect.map((current) => current.viewcodeRelay.url ?? null),
        Effect.orElseSucceed(() => null),
      ),
      saveRelaySettings: (patch) =>
        settings
          .updateSettings({ viewcodeRelay: patch })
          .pipe(
            Effect.asVoid,
            Effect.mapError(storeFailure("Could not save Quick connect settings.")),
          ),
    };

    return yield* makeRelaySetup({
      prepare: prepareNodeWrangler(import.meta.dirname).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
      store,
      probe: probeRelay,
      http,
    });
  }),
);

const unavailable = new ViewCodeRelaySetupError({
  detail: "Quick connect setup is not available on this server.",
});

/** For tests and hosts without setup: always idle. */
export const layerUnavailable = Layer.succeed(
  ViewCodeRelaySetup,
  ViewCodeRelaySetup.of({
    changes: Stream.make(idleState),
    current: Effect.succeed(idleState),
    start: () => Effect.fail(unavailable),
    cancel: Effect.void,
    continueSetup: Effect.fail(unavailable),
    chooseAccount: () => Effect.fail(unavailable),
    remove: () => Effect.fail(unavailable),
    relayConnected: Effect.void,
  }),
);
