/**
 * ViewCode Quick connect relay Worker. Every request, from the host's own
 * socket to phones and browsers, goes to the one Durable Object that holds
 * the host connection.
 */
import type { Env } from "./relayDurableObject.ts";

export { RelayDurableObject } from "./relayDurableObject.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName("host")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
