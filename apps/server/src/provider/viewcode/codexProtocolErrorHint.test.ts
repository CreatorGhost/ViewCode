import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkCodexProviderStatus } from "../CodexProvider.ts";
import { codexProtocolErrorHint } from "./codexProtocolErrorHint.ts";

const hint =
  "Codex returned invalid app-server output. Update the Codex CLI, or select a current executable in Settings → Providers → Codex → Binary path.";
const raw = "SENSITIVE_RAW_PROVIDER_OUTPUT";
const wireError = new CodexErrors.CodexAppServerProtocolParseError({
  operation: "decode-wire-message",
  cause: new Error(raw),
});
const settings = Schema.decodeSync(CodexSettings)({ enabled: true });

it("recognizes only the exact wire decoding operation and never copies raw output", () => {
  assert.equal(codexProtocolErrorHint(wireError), hint);
  assert.notInclude(hint, raw);
  for (const operation of CodexErrors.CodexAppServerProtocolParseOperation.literals) {
    if (operation === "decode-wire-message") continue;
    assert.isUndefined(
      codexProtocolErrorHint(new CodexErrors.CodexAppServerProtocolParseError({ operation })),
    );
  }
  for (const error of [new Error("decode-wire-message"), "decode-wire-message", null, undefined]) {
    assert.isUndefined(codexProtocolErrorHint(error));
  }
});

describe("Codex probe compatibility diagnostics", () => {
  it.effect(
    "reports actionable wire failure without exposing its raw cause or claiming a version",
    () =>
      Effect.gen(function* () {
        const provider = yield* checkCodexProviderStatus(settings, () => Effect.fail(wireError));
        assert.equal(provider.status, "error");
        assert.isTrue(provider.enabled);
        assert.isTrue(provider.installed);
        assert.equal(provider.version, null);
        assert.equal(provider.auth.status, "unknown");
        assert.equal(provider.message, hint);
        assert.notInclude(JSON.stringify(provider), raw);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("leaves unrelated probe failures unchanged", () =>
    Effect.gen(function* () {
      const error = new CodexErrors.CodexAppServerProtocolParseError({
        operation: "decode-response-payload",
        method: "account/read",
        cause: new Error(raw),
      });
      const provider = yield* checkCodexProviderStatus(settings, () => Effect.fail(error));
      assert.equal(provider.message, `Codex app-server provider probe failed: ${error.message}.`);
      assert.notInclude(JSON.stringify(provider), raw);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("does not probe or enable a disabled provider", () =>
    Effect.gen(function* () {
      let probes = 0;
      const provider = yield* checkCodexProviderStatus({ ...settings, enabled: false }, () => {
        probes++;
        return Effect.fail(wireError);
      });
      assert.equal(probes, 0);
      assert.isFalse(provider.enabled);
      assert.equal(provider.message, "Codex is disabled in ViewCode settings.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
