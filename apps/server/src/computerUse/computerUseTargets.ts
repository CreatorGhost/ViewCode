/**
 * Per-thread window ids and element refs. The agent only ever sees these
 * small integers; the driver's handles stay on the server.
 *
 * Ids and refs are monotonic and never reused for the life of the server
 * process, even after the thread's session stops (`reset` keeps the counters),
 * so a number from an earlier session cannot land on a different target.
 * Each server run starts its numbers at a random base, so a number an agent
 * quotes from before a restart (resumed sessions keep their history) reads as
 * unknown instead of landing on whatever this run minted under it.
 */
import * as NodeCrypto from "node:crypto";

import type { ComputerUseRect } from "@t3tools/contracts";

import type { DriverElement, DriverWindow } from "./ComputerDriver.ts";

export interface WindowRecord {
  readonly id: number;
  readonly handle: string;
  readonly app: string;
  readonly appIdentifier?: string;
  readonly pid: number;
  readonly title: string;
  readonly focused: boolean;
}

export interface RefRecord {
  readonly ref: number;
  readonly windowId: number;
  readonly observation: number;
  readonly handle: string;
  readonly role: string;
  readonly label: string;
}

export interface ShotRecord {
  readonly shot: number;
  readonly windowId: number;
  /** The driver window handle the image was taken of. */
  readonly handle: string;
  readonly width: number;
  readonly height: number;
  /** Logical screen rect the image covers. */
  readonly bounds: ComputerUseRect;
  readonly maxSize: number;
}

export type ShotLookup =
  | { readonly _tag: "Found"; readonly shot: ShotRecord; readonly window: WindowRecord }
  | { readonly _tag: "Unknown" }
  /** Not the window's newest screenshot, or its window closed. */
  | { readonly _tag: "Retired"; readonly reason: "newer-shot" | "window-closed" };

export type RefLookup =
  | { readonly _tag: "Found"; readonly ref: RefRecord; readonly window: WindowRecord }
  /** Never minted for this thread. */
  | { readonly _tag: "Unknown" }
  /** Minted, but a newer observation, the cap or a closed window retired it. */
  | { readonly _tag: "Retired"; readonly reason: "newer-observation" | "window-closed" };

/** Refs kept per thread; the oldest observations go first. */
export const MAX_REFS_PER_THREAD = 2000;

/** First number of this server run; ids before it belong to another run. */
const RUN_ID_BASE = NodeCrypto.randomInt(1, 100_000) * 100;

export class ThreadTargets {
  private readonly firstId: number;
  private nextWindowId: number;
  private nextRef: number;
  private nextObservation = 1;
  private nextShot: number;
  /** Only each window's newest shot is kept: older ones can never be used. */
  private readonly latestShotByWindow = new Map<number, ShotRecord>();
  private readonly windows = new Map<number, WindowRecord>();
  private readonly windowIdByHandle = new Map<string, number>();
  private readonly refs = new Map<number, RefRecord>();
  private readonly latestObservationByWindow = new Map<number, number>();

  constructor(firstId: number = RUN_ID_BASE) {
    this.firstId = firstId;
    this.nextWindowId = firstId;
    this.nextRef = firstId;
    this.nextShot = firstId;
  }
  /** Observation order for the cap: oldest first. */
  private readonly observations: Array<{ readonly observation: number; readonly refs: number[] }> =
    [];

  /**
   * Reconciles a full driver listing. A handle keeps its id while it still
   * names the same process and app; windows missing from the listing are
   * closed and their ids stop resolving.
   */
  recordWindows(listed: ReadonlyArray<DriverWindow>): ReadonlyArray<WindowRecord> {
    const seen = new Set<number>();
    const records = listed.map((window) => {
      const existingId = this.windowIdByHandle.get(window.handle);
      const existing = existingId === undefined ? undefined : this.windows.get(existingId);
      const sameTarget =
        existing !== undefined && existing.pid === window.pid && existing.app === window.app;
      const id = sameTarget ? existing.id : this.nextWindowId++;
      const record: WindowRecord = {
        id,
        handle: window.handle,
        app: window.app,
        ...(window.appIdentifier !== undefined ? { appIdentifier: window.appIdentifier } : {}),
        pid: window.pid,
        title: window.title,
        focused: window.focused,
      };
      this.windows.set(id, record);
      this.windowIdByHandle.set(window.handle, id);
      seen.add(id);
      return record;
    });
    for (const id of this.windows.keys()) {
      if (!seen.has(id)) this.closeWindow(id);
    }
    return records;
  }

  window(id: number): WindowRecord | undefined {
    return this.windows.get(id);
  }

  closeWindow(id: number): void {
    const record = this.windows.get(id);
    if (!record) return;
    this.windows.delete(id);
    if (this.windowIdByHandle.get(record.handle) === id)
      this.windowIdByHandle.delete(record.handle);
    this.latestObservationByWindow.delete(id);
    this.latestShotByWindow.delete(id);
  }

  /** Mints a shot id; it becomes the window's only usable shot for coordinates. */
  recordShot(windowId: number, shot: Omit<ShotRecord, "shot" | "windowId">): ShotRecord {
    const record: ShotRecord = { ...shot, shot: this.nextShot++, windowId };
    this.latestShotByWindow.set(windowId, record);
    return record;
  }

  /** The window's newest shot, if any (used to repeat its size after an action). */
  latestShot(windowId: number): ShotRecord | undefined {
    return this.latestShotByWindow.get(windowId);
  }

  /** The window moved since this shot: coordinates need a fresh one. */
  retireShot(shot: number): void {
    for (const [windowId, record] of this.latestShotByWindow) {
      if (record.shot === shot) this.latestShotByWindow.delete(windowId);
    }
  }

  lookupShot(shot: number): ShotLookup {
    if (shot < this.firstId || shot >= this.nextShot) return { _tag: "Unknown" };
    for (const record of this.latestShotByWindow.values()) {
      if (record.shot !== shot) continue;
      const window = this.windows.get(record.windowId);
      return window
        ? { _tag: "Found", shot: record, window }
        : { _tag: "Retired", reason: "window-closed" };
    }
    return { _tag: "Retired", reason: "newer-shot" };
  }

  /** Mints refs for one observation; older refs of that window stop resolving. */
  recordObservation(
    windowId: number,
    elements: ReadonlyArray<DriverElement>,
  ): ReadonlyArray<{ readonly ref: number; readonly element: DriverElement }> {
    const observation = this.nextObservation++;
    this.latestObservationByWindow.set(windowId, observation);
    const minted = elements.map((element) => {
      const ref = this.nextRef++;
      this.refs.set(ref, {
        ref,
        windowId,
        observation,
        handle: element.handle,
        role: element.role,
        label: element.label,
      });
      return { ref, element };
    });
    this.observations.push({ observation, refs: minted.map(({ ref }) => ref) });
    while (this.refs.size > MAX_REFS_PER_THREAD && this.observations.length > 1) {
      const oldest = this.observations.shift();
      for (const ref of oldest?.refs ?? []) this.refs.delete(ref);
    }
    return minted;
  }

  lookupRef(ref: number): RefLookup {
    if (ref < this.firstId || ref >= this.nextRef) return { _tag: "Unknown" };
    const record = this.refs.get(ref);
    if (!record) return { _tag: "Retired", reason: "newer-observation" };
    const window = this.windows.get(record.windowId);
    if (!window) return { _tag: "Retired", reason: "window-closed" };
    if (this.latestObservationByWindow.get(record.windowId) !== record.observation) {
      return { _tag: "Retired", reason: "newer-observation" };
    }
    return { _tag: "Found", ref: record, window };
  }

  /** Forgets every window and ref but keeps the counters, so numbers are never reused. */
  reset(): void {
    this.windows.clear();
    this.windowIdByHandle.clear();
    this.refs.clear();
    this.latestObservationByWindow.clear();
    this.latestShotByWindow.clear();
    this.observations.length = 0;
  }
}
