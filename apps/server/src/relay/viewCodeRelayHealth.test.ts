import { describe, expect, it } from "vite-plus/test";
import * as NetAddress from "effect/unstable/net/NetAddress";

import {
  classifyDialError,
  type DialFailure,
  describeErrorChain,
  initialRelayHealth,
  reconnectDelayMs,
  RELAY_REASON,
  reduceRelayHealth,
  resolveLocalTarget,
} from "./viewCodeRelayHealth.ts";

describe("reconnectDelayMs", () => {
  it("doubles from 1s to a 30s ceiling and shaves at most half off", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((attempt) => reconnectDelayMs(attempt, 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(reconnectDelayMs(0, 0.999)).toBe(500);
    expect(reconnectDelayMs(5, 0.5)).toBe(22_500);
  });
});

describe("classifyDialError", () => {
  it("names an untrusted issuer from Node's codes and messages", () => {
    for (const text of [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "TypeError fetch failed UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "unable to get local issuer certificate",
      "self-signed certificate in certificate chain",
    ]) {
      expect(classifyDialError(text).kind).toBe("tls-untrusted");
    }
    expect(classifyDialError("ECONNREFUSED").kind).toBe("network");
    expect(classifyDialError("getaddrinfo ENOTFOUND relay.example.workers.dev").kind).toBe(
      "network",
    );
  });

  it("reads codes through the cause chain", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("boom"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    });
    expect(classifyDialError(describeErrorChain(error)).kind).toBe("tls-untrusted");
  });
});

describe("connection resets", () => {
  const fetchFailed = (cause: Error) => new TypeError("fetch failed", { cause });
  const resets = {
    "node ECONNRESET": fetchFailed(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" }),
    ),
    "undici other side closed": fetchFailed(
      Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    ),
    "socket hang up": fetchFailed(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    ),
    "closed before TLS": fetchFailed(
      new Error("Client network socket disconnected before secure TLS connection was established"),
    ),
  };

  it("counts a reset or aborted handshake as a network block, not an offline network", () => {
    for (const error of Object.values(resets)) {
      expect(classifyDialError(describeErrorChain(error)).kind).toBe("network-reset");
    }
  });

  it("puts the cause code in the flattened chain", () => {
    expect(describeErrorChain(resets["undici other side closed"])).toContain("UND_ERR_SOCKET");
  });

  it("keeps DNS failures, timeouts and 5xx as ordinary network trouble", () => {
    for (const error of [
      fetchFailed(
        Object.assign(new Error("getaddrinfo ENOTFOUND relay.example.workers.dev"), {
          code: "ENOTFOUND",
        }),
      ),
      fetchFailed(
        Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      ),
      new Error("The relay answered 502."),
    ]) {
      expect(classifyDialError(describeErrorChain(error)).kind).toBe("network");
    }
  });

  it("blocks after three resets in a row, naming the reset, and a good attempt clears it", () => {
    const reset = classifyDialError(describeErrorChain(resets["node ECONNRESET"]));
    let health = initialRelayHealth;
    for (let index = 0; index < 2; index += 1) {
      health = reduceRelayHealth(health, { type: "dial-failed", failure: reset });
      expect(health.status).toBe("reconnecting");
    }
    health = reduceRelayHealth(health, { type: "dial-failed", failure: reset });
    expect(health).toMatchObject({ status: "blocked", reason: RELAY_REASON.reset });
    expect(RELAY_REASON.reset).not.toBe(RELAY_REASON.untrusted);
    expect(reduceRelayHealth(health, { type: "connected" }).status).toBe("connected");
  });

  it("does not let a timeout in between count towards blocked", () => {
    const reset: DialFailure = { kind: "network-reset", detail: "ECONNRESET" };
    let health = initialRelayHealth;
    for (const failure of [reset, reset, { kind: "network", detail: "timeout" } as const, reset]) {
      health = reduceRelayHealth(health, { type: "dial-failed", failure });
    }
    expect(health.status).toBe("reconnecting");
  });
});

describe("reduceRelayHealth", () => {
  it("shows connecting on the first attempt and reconnecting afterwards", () => {
    const first = reduceRelayHealth(initialRelayHealth, { type: "attempt" });
    expect(first.status).toBe("connecting");
    const connected = reduceRelayHealth(first, { type: "connected" });
    const dropped = reduceRelayHealth(connected, { type: "dropped", reason: "gone" });
    expect(dropped).toMatchObject({ status: "reconnecting", reason: "gone" });
    expect(reduceRelayHealth(dropped, { type: "attempt" }).status).toBe("reconnecting");
  });

  it("keeps blocked and auth-failed through further attempts, and turns off cleanly", () => {
    let health = initialRelayHealth;
    for (let index = 0; index < 3; index += 1) {
      health = reduceRelayHealth(health, {
        type: "dial-failed",
        failure: { kind: "tls-untrusted", detail: "x" },
      });
    }
    expect(health.status).toBe("blocked");
    expect(reduceRelayHealth(health, { type: "attempt" }).status).toBe("blocked");
    expect(reduceRelayHealth(health, { type: "off" })).toEqual(initialRelayHealth);
    const refused = reduceRelayHealth(initialRelayHealth, {
      type: "dial-failed",
      failure: { kind: "auth" },
    });
    expect(reduceRelayHealth(refused, { type: "attempt" }).status).toBe("auth-failed");
  });
});

describe("resolveLocalTarget", () => {
  it("uses loopback for a wildcard bind and the socket path in no-port mode", () => {
    expect(resolveLocalTarget(NetAddress.inetAddressFromStringUnsafe("0.0.0.0:3773"))).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 3773,
    });
    expect(resolveLocalTarget(NetAddress.inetAddressFromStringUnsafe("192.168.1.5:3773"))).toEqual({
      kind: "tcp",
      host: "192.168.1.5",
      port: 3773,
    });
    expect(resolveLocalTarget(NetAddress.unixPathAddress("/tmp/vc.sock"))).toEqual({
      kind: "socket",
      path: "/tmp/vc.sock",
    });
  });
});
