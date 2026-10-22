import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

// ViewCode guards (861f4a814): a refused pairing code is named when it expired or was used,
// and a requested code lifetime stays between one and fifteen minutes.

it.effect("names expired and already-used pairing codes without naming unknown ones", () =>
  Effect.sync(() => {
    const problem = (cause: PairingGrantStore.BootstrapCredentialError) =>
      EnvironmentAuth.serverAuthPairingProblem(
        EnvironmentAuth.toBootstrapExchangeError(cause) as never,
      );

    expect(problem(new PairingGrantStore.ExpiredBootstrapCredentialError({}))).toBe("expired");
    expect(problem(new PairingGrantStore.ConsumedBootstrapCredentialError({}))).toBe("used");
    expect(problem(new PairingGrantStore.UnknownBootstrapCredentialError({}))).toBeUndefined();
    expect(problem(new PairingGrantStore.UnavailableBootstrapCredentialError({}))).toBeUndefined();
  }),
);

it.effect("clamps requested pairing code lifetimes to one to fifteen minutes", () =>
  Effect.sync(() => {
    const seconds = (value: number) =>
      Duration.toSeconds(EnvironmentAuth.clampPairingCredentialTtl(value));
    expect(seconds(900)).toBe(900);
    expect(seconds(3600)).toBe(900);
    expect(seconds(1)).toBe(60);
    expect(seconds(Number.NaN)).toBe(60);
  }),
);
