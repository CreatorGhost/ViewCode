import * as Predicate from "effect/Predicate";

/** A listen that failed because something already holds the address. */
export function isAddressInUse(error: unknown): boolean {
  return (
    Predicate.isTagged(error, "ServeError") &&
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "code") &&
    error.cause.code === "EADDRINUSE"
  );
}

export function addressInUseMessage(port: number): string {
  return `Port ${port} is already in use. Stop what is using it, or start ViewCode on another port with --port <number>.`;
}
