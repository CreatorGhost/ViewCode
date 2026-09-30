import { describe, expect, it } from "vite-plus/test";

import {
  closeEndsHostSession,
  currentHost,
  isHostAuthorized,
  routeRequest,
  socketsToReplace,
} from "./routing.ts";

describe("routeRequest", () => {
  const base = { upgrade: null, hostAuthorized: false } as const;

  it("accepts only an authorized WebSocket upgrade at the host path", () => {
    expect(
      routeRequest({ pathname: "/__viewcode/host", upgrade: "websocket", hostAuthorized: true }),
    ).toEqual({ kind: "host-connect" });
    expect(
      routeRequest({ pathname: "/__viewcode/host", upgrade: "WebSocket", hostAuthorized: true }),
    ).toEqual({ kind: "host-connect" });
    expect(
      routeRequest({ pathname: "/__viewcode/host", upgrade: "websocket", hostAuthorized: false }),
    ).toEqual({ kind: "reject", status: 401 });
    // A wrong secret is 401 before the upgrade check, so the probe can tell them apart.
    expect(routeRequest({ ...base, pathname: "/__viewcode/host" })).toEqual({
      kind: "reject",
      status: 401,
    });
    expect(
      routeRequest({ pathname: "/__viewcode/host", upgrade: null, hostAuthorized: true }),
    ).toEqual({
      kind: "reject",
      status: 426,
    });
  });

  it("keeps relay-internal paths away from the host", () => {
    expect(routeRequest({ ...base, pathname: "/__viewcode/other" })).toEqual({
      kind: "reject",
      status: 404,
    });
  });

  it("proxies everything a phone or browser sends, including upgrades", () => {
    for (const pathname of [
      "/pair",
      "/api/orchestration",
      "/ws",
      "/.well-known/t3/environment",
      "/",
    ]) {
      expect(routeRequest({ ...base, pathname })).toEqual({ kind: "proxy" });
    }
    expect(routeRequest({ pathname: "/ws", upgrade: "websocket", hostAuthorized: true })).toEqual({
      kind: "proxy",
    });
  });
});

describe("isHostAuthorized", () => {
  it("matches only the exact bearer secret", async () => {
    expect(await isHostAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(await isHostAuthorized("Bearer s3cret ", "s3cret")).toBe(false);
    expect(await isHostAuthorized("Bearer nope", "s3cret")).toBe(false);
    expect(await isHostAuthorized("s3cret", "s3cret")).toBe(false);
    expect(await isHostAuthorized(null, "s3cret")).toBe(false);
    expect(await isHostAuthorized("Bearer x", undefined)).toBe(false);
    expect(await isHostAuthorized("Bearer ", "")).toBe(false);
  });
});

describe("host replacement", () => {
  const old = { id: "a", connectedAt: 1 };
  const next = { id: "b", connectedAt: 2 };

  it("makes the newest connection the host and closes the rest", () => {
    expect(currentHost([old, next])).toEqual(next);
    expect(currentHost([])).toBeNull();
    expect(socketsToReplace([old, next], "b")).toEqual(["a"]);
    expect(socketsToReplace([next], "b")).toEqual([]);
  });

  it("lets a replaced socket close without ending the new host's session", () => {
    expect(closeEndsHostSession([old, next], "a")).toBe(false);
    expect(closeEndsHostSession([next], "b")).toBe(true);
  });
});
