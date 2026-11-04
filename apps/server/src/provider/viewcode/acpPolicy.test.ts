import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as AcpSchema from "effect-acp/compat";
import {
  configureDroidSession,
  droidAutonomyLevel,
  parseDroidModelList,
} from "./droidAcpSupport.ts";
import { configureDevinSession, devinModeId, parseDevinModelList } from "./devinAcpSupport.ts";

const makeRuntime = () => {
  const configured: Array<readonly [string, string | boolean]> = [];
  const configOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [
    {
      id: "autonomy_level",
      name: "Autonomy",
      type: "select",
      currentValue: "normal",
      options: ["normal", "spec", "auto-low", "auto-medium"].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "swe-1-6-fast",
      options: [{ value: "swe-1-6-fast", name: "SWE 1.6" }],
    },
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "accept-edits",
      options: ["ask", "plan", "accept-edits", "bypass"].map((value) => ({ value, name: value })),
    },
  ];
  const runtime = {
    getConfigOptions: Effect.succeed(configOptions),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.sync(() => {
        configured.push([id, value]);
      }),
    setMode: (mode: string) =>
      Effect.sync(() => {
        configured.push(["mode", mode]);
      }),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
  return { runtime, configured };
};

describe("ViewCode ACP provider policy", () => {
  it.effect("caps Droid autonomy at the organization limit and exits plan mode", () =>
    Effect.gen(function* () {
      const h = makeRuntime();
      yield* configureDroidSession({
        runtime: h.runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
        model: "claude-opus-5-5",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      assert.deepEqual(h.configured, [
        ["model", "claude-opus-5-5"],
        ["reasoning_effort", "high"],
        ["autonomy_level", "spec"],
      ]);
      yield* configureDroidSession({
        runtime: h.runtime,
        runtimeMode: "full-access",
        interactionMode: "default",
        model: undefined,
        options: undefined,
      });
      assert.deepEqual(h.configured.at(-1), ["autonomy_level", "auto-medium"]);
      assert.isUndefined(
        droidAutonomyLevel({ runtimeMode: "full-access", interactionMode: "default", allowed: [] }),
      );
    }),
  );

  it.effect("matches Devin model families and maps plan/default/full-access modes", () =>
    Effect.gen(function* () {
      const h = makeRuntime();
      yield* configureDevinSession({
        runtime: h.runtime,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        model: "swe-1-6",
      });
      assert.deepEqual(h.configured, [
        ["model", "swe-1-6-fast"],
        ["mode", "plan"],
      ]);
      assert.equal(
        devinModeId({ runtimeMode: "approval-required", interactionMode: "default" }),
        "accept-edits",
      );
      assert.equal(
        devinModeId({ runtimeMode: "full-access", interactionMode: "default" }),
        "bypass",
      );
    }),
  );

  it("preserves native model discovery without inventing extra model ids", () => {
    assert.deepEqual(
      parseDroidModelList(
        "Available built-in models:\n  auto, claude-opus-5-5\n\nAvailable custom models:\n  custom:Mine-0 (My Model)\n",
      ).map((model) => model.slug),
      ["auto", "claude-opus-5-5", "custom:Mine-0"],
    );
    assert.deepEqual(
      parseDevinModelList('{"families":[{"family_uid":"swe-1-6","family_label":"SWE 1.6"}]}').map(
        (model) => model.slug,
      ),
      ["swe-1-6"],
    );
  });
});
