import { makeSocketFetch } from "@t3tools/shared/socketFetch";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

export type LocalServerTarget = Pick<PersistedServerRuntimeState, "origin" | "listenPath">;

/** Override only a self-request, so relay/host requests keep their normal network transport. */
export const withLocalServerTransport =
  (target: Pick<LocalServerTarget, "listenPath">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    target.listenPath === undefined
      ? effect
      : effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, makeSocketFetch(target.listenPath)),
        );
