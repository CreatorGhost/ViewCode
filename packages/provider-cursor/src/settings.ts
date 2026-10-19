import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How a Cursor instance runs: Cursor's own `cursor-agent` CLI over ACP, or `@cursor/sdk` in-process. */
export const CursorRuntime = Schema.Literals(["cursor-agent", "sdk"]);
export type CursorRuntime = typeof CursorRuntime.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // ViewCode: absent means automatic (apps/server/src/provider/viewcode/cursorRuntime.ts).
    runtime: Schema.optionalKey(CursorRuntime).pipe(
      Schema.annotateKey({
        title: "Runtime",
        description:
          "Cursor CLI runs Cursor's own cursor-agent with its own sign-in; SDK runs Cursor inside ViewCode. Automatic prefers the CLI on macOS.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "auto", label: "Automatic" },
            { value: "cursor-agent", label: "Cursor CLI (cursor-agent)" },
            { value: "sdk", label: "Cursor SDK" },
          ],
          clearWhenEmpty: "omit",
        },
      }),
    ),
    binaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to cursor-agent. Used by the Cursor CLI runtime.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["runtime", "binaryPath"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;
