/**
 * The desktop driver behind computer use. It knows nothing about threads,
 * refs, approvals or policy: `ComputerUseService` owns all of that and talks
 * to the driver only in opaque handles the driver minted.
 *
 * Handles are only valid inside the driver process that minted them. A
 * driver restart forgets every handle, so the service must treat an unknown
 * handle as stale, never as "try the closest match".
 *
 * Mutating calls carry the identity the service last observed (`expect`).
 * The driver re-reads the element at dispatch and refuses with `stale` when
 * role or label no longer match, so an action cannot land on a control that
 * replaced the one the agent saw.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { ComputerUseRect } from "@t3tools/contracts";

export interface DriverWindow {
  readonly handle: string;
  readonly app: string;
  readonly pid: number;
  readonly title: string;
  readonly focused: boolean;
  readonly bounds?: ComputerUseRect;
  /** Bundle id or executable path when the platform reports one; used by the denylist. */
  readonly appIdentifier?: string;
}

export interface DriverElement {
  readonly handle: string;
  readonly role: string;
  readonly label: string;
  /** Already clipped by the driver; absent for secure text fields. */
  readonly value?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
}

export interface DriverElementIdentity {
  readonly role: string;
  readonly label: string;
}

export interface DriverStatus {
  readonly available: boolean;
  readonly accessibility: "granted" | "denied" | "unknown";
  readonly reason?: string;
}

export type DriverErrorKind =
  /** Platform unsupported, native module missing, or the worker would not start. */
  | "unavailable"
  /** Accessibility not granted to the process the driver runs as. */
  | "permission-accessibility"
  /** Screen Recording not granted (screenshots). */
  | "permission-screen"
  /** Handle unknown to this driver process, or identity no longer matches. */
  | "stale"
  /** The OS refused or the action is unsupported on the element. */
  | "failed"
  | "timeout"
  /** The driver process answered with something that is not a valid reply. */
  | "malformed";

export class ComputerDriverError extends Data.TaggedError("ComputerDriverError")<{
  readonly kind: DriverErrorKind;
  /** Safe to show: never contains typed text, values or window contents. */
  readonly message: string;
  /**
   * For input calls: whether the OS may have received the input. `unknown`
   * when the driver died or timed out after dispatching.
   */
  readonly dispatched: "no" | "yes" | "unknown";
}> {}

export interface ComputerDriverShape {
  readonly status: () => Effect.Effect<DriverStatus>;
  readonly listWindows: () => Effect.Effect<ReadonlyArray<DriverWindow>, ComputerDriverError>;
  readonly observe: (
    windowHandle: string,
    options: { readonly maxElements: number },
  ) => Effect.Effect<
    { readonly elements: ReadonlyArray<DriverElement>; readonly truncated: boolean },
    ComputerDriverError
  >;
  /** Writes a PNG to `outputPath`. */
  readonly screenshot: (
    windowHandle: string,
    outputPath: string,
  ) => Effect.Effect<{ readonly width: number; readonly height: number }, ComputerDriverError>;
  readonly press: (
    elementHandle: string,
    expect: DriverElementIdentity,
  ) => Effect.Effect<void, ComputerDriverError>;
  readonly setValue: (
    elementHandle: string,
    expect: DriverElementIdentity,
    value: string,
  ) => Effect.Effect<void, ComputerDriverError>;
  readonly typeText: (
    elementHandle: string,
    expect: DriverElementIdentity,
    text: string,
  ) => Effect.Effect<void, ComputerDriverError>;
  /** Focuses the window, then sends the chord (already validated by the contract pattern). */
  readonly key: (windowHandle: string, keys: string) => Effect.Effect<void, ComputerDriverError>;
  readonly scroll: (
    elementHandle: string,
    expect: DriverElementIdentity,
    dx: number,
    dy: number,
  ) => Effect.Effect<void, ComputerDriverError>;
}

export class ComputerDriver extends Context.Service<ComputerDriver, ComputerDriverShape>()(
  "@t3tools/server/computerUse/ComputerDriver",
) {}
