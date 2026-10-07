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
 *
 * Coordinate calls take points in logical screen coordinates (the service
 * maps screenshot pixels using the bounds the screenshot reported) plus the
 * window bounds that screenshot was taken at. The driver brings the window to
 * the front, re-reads its bounds and refuses with `stale` when they differ, so
 * a click cannot land on a window that moved or on something now covering it.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ComputerUseError, ComputerUseErrorCode, ComputerUseRect } from "@t3tools/contracts";

export interface DriverDispatchTarget {
  readonly window: DriverWindow;
  readonly element?: DriverElementIdentity;
}

/** The server rechecks policy when the worker is ready to send native input. */
export const ComputerDriverDispatchCheck = Context.Reference<
  (target: DriverDispatchTarget) => Effect.Effect<ComputerUseError | undefined>
>("t3/computerUse/ComputerDriverDispatchCheck", {
  defaultValue: () => () => Effect.undefined,
});

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

export interface DriverPoint {
  readonly x: number;
  readonly y: number;
}

export interface DriverStatus {
  readonly available: boolean;
  readonly accessibility: "granted" | "denied" | "unknown";
  readonly reason?: string;
}

export type DriverErrorKind =
  | "policy"
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
  readonly code?: ComputerUseErrorCode;
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
  /**
   * Writes a PNG of the window to `outputPath`, its longest edge at most
   * `maxSize` pixels. `bounds` is the screen region (logical coordinates) the
   * image covers, which the service uses to map image pixels to the screen.
   */
  readonly screenshot: (
    windowHandle: string,
    outputPath: string,
    options: { readonly maxSize: number },
  ) => Effect.Effect<
    { readonly width: number; readonly height: number; readonly bounds: ComputerUseRect },
    ComputerDriverError
  >;
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
  /**
   * Best effort, read only: the smallest labelled element under `point`, so
   * approvals and the destructive check can name what a coordinate click hits.
   * `null` when nothing labelled is there or the app exposes no tree.
   */
  readonly elementAt: (
    windowHandle: string,
    point: DriverPoint,
  ) => Effect.Effect<DriverElementIdentity | null, ComputerDriverError>;
  readonly click: (
    windowHandle: string,
    expectBounds: ComputerUseRect,
    point: DriverPoint,
    options: { readonly button: "left" | "right" | "middle"; readonly count: number },
  ) => Effect.Effect<void, ComputerDriverError>;
  readonly drag: (
    windowHandle: string,
    expectBounds: ComputerUseRect,
    from: DriverPoint,
    to: DriverPoint,
  ) => Effect.Effect<void, ComputerDriverError>;
  readonly move: (
    windowHandle: string,
    expectBounds: ComputerUseRect,
    point: DriverPoint,
  ) => Effect.Effect<void, ComputerDriverError>;
  readonly scrollAt: (
    windowHandle: string,
    expectBounds: ComputerUseRect,
    point: DriverPoint,
    dx: number,
    dy: number,
  ) => Effect.Effect<void, ComputerDriverError>;
  /** Brings the window to the front, then types into its focused element. */
  readonly typeFocused: (
    windowHandle: string,
    text: string,
  ) => Effect.Effect<void, ComputerDriverError>;
}

export class ComputerDriver extends Context.Service<ComputerDriver, ComputerDriverShape>()(
  "t3/computerUse/ComputerDriver",
) {}
