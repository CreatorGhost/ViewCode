import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const cliEntitlementsPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(
    new URL("../apps/server/resources/cli-entitlements.plist", import.meta.url),
  );
});

it.layer(NodeServices.layer)("macOS signing", (it) => {
  it.effect("batches codesign calls and preserves custom options for Electron helpers", () =>
    Effect.gen(function* () {
      const fileOptions = { entitlements: "/tmp/t3code.entitlements.plist", hardenedRuntime: true };
      const optionsForFile = vi.fn(() => fileOptions);
      const options = {
        app: "/tmp/T3 Code.app",
        identity: "Developer ID Application: T3 Tools, Inc.",
        keychain: "/tmp/t3code.keychain",
        provisioningProfile: "/tmp/t3code.provisionprofile",
        optionsForFile,
      } satisfies SignOptions;
      yield* Effect.promise(() => sign(options));
      expect(signApplication).toHaveBeenCalledExactlyOnceWith({
        ...options,
        batchCodesignCalls: true,
        optionsForFile: expect.any(Function),
      });
      const signedOptions = vi.mocked(signApplication).mock.calls[0]![0];
      const helper = "/tmp/T3 Code.app/Contents/Frameworks/T3 Code Helper.app";
      const context = { platform: "darwin" as const };
      expect(signedOptions.optionsForFile?.(helper, context)).toEqual(fileOptions);
      expect(optionsForFile).toHaveBeenCalledExactlyOnceWith(helper, context);
    }),
  );

  it.effect(
    "gives the standalone server its CLI entitlements while retaining other signing options",
    () =>
      Effect.gen(function* () {
        const base = { entitlements: "/tmp/electron.entitlements.plist", hardenedRuntime: true };
        yield* Effect.promise(() => sign({ app: "/tmp/T3 Code.app", optionsForFile: () => base }));
        const signedOptions = vi.mocked(signApplication).mock.calls[0]![0];
        const expectedEntitlements = yield* cliEntitlementsPath;
        expect(
          signedOptions.optionsForFile?.("/tmp/T3 Code.app/Contents/Resources/t3-server/t3", {
            platform: "darwin",
          }),
        ).toEqual({ ...base, entitlements: expectedEntitlements });
        expect(base.entitlements).toBe("/tmp/electron.entitlements.plist");
      }),
  );

  it.effect("supplies CLI entitlements when no per-file callback was configured", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => sign({ app: "/tmp/T3 Code.app" }));
      const signedOptions = vi.mocked(signApplication).mock.calls[0]![0];
      expect(
        signedOptions.optionsForFile?.(
          "/tmp/T3 Code.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
          { platform: "darwin" },
        ),
      ).toEqual({});
      const serverOptions = signedOptions.optionsForFile?.(
        "/tmp/T3 Code.app/Contents/Resources/t3-server/t3",
        { platform: "darwin" },
      );
      expect(serverOptions).toEqual({ entitlements: yield* cliEntitlementsPath });
    }),
  );
});
