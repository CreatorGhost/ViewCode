import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HostProcessPlatform, isHostWindows } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

describe("ViewCode and native host process imports", () => {
  it.effect("applies a compatibility override to native runtime consumers", () =>
    Effect.gen(function* () {
      expect(yield* HostProcess.Platform).toBe("win32");
      expect(yield* HostProcess.isWindows).toBe(true);
      expect(yield* isHostWindows).toBe(true);
    }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
  );

  it.effect("applies a native override to ViewCode runtime consumers", () =>
    Effect.gen(function* () {
      expect(yield* HostProcessPlatform).toBe("darwin");
      expect(yield* isHostWindows).toBe(false);
      expect(yield* HostProcess.isWindows).toBe(false);
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );
});
