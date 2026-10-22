/**
 * Each array a streaming RPC handler emits goes to the client as one WebSocket
 * message. Quick connect's relay (a Cloudflare Durable Object) closes the
 * client's socket on any message over 1 MiB, so batches stay well below it.
 * A single larger item still travels alone.
 */
export const RPC_STREAM_CHUNK_MAX_BYTES = 512 * 1024;

/** Splits `items` into runs whose summed size stays within `maxBytes`; never an empty run. */
export function splitByBytes<A>(
  items: ReadonlyArray<A>,
  sizeOf: (item: A) => number,
  maxBytes: number = RPC_STREAM_CHUNK_MAX_BYTES,
): Array<Array<A>> {
  const batches: Array<Array<A>> = [];
  let current: Array<A> = [];
  let currentBytes = 0;
  for (const item of items) {
    const bytes = sizeOf(item);
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
