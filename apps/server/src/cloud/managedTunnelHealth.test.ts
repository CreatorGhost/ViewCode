import { describe, expect, it } from "vite-plus/test";

import {
  classifyTunnelSignal,
  initialTunnelHealth,
  reduceTunnelHealth,
  SHORT_REGISTRATION_MS,
  type TunnelHealth,
  type TunnelHealthEvent,
} from "./managedTunnelHealth.ts";

const run = (events: ReadonlyArray<TunnelHealthEvent>, from: TunnelHealth = initialTunnelHealth) =>
  events.reduce(reduceTunnelHealth, from);

describe("classifyTunnelSignal", () => {
  it("reads the TLS refusal a TLS-inspecting firewall causes", () => {
    expect(
      classifyTunnelSignal(
        'ERR Unable to establish connection with Cloudflare edge error="failed to dial to edge with quic: tls: failed to verify certificate: x509: certificate signed by unknown authority (possibly because of \\"x509: invalid signature\\" while trying to verify candidate authority certificate \\"decrypt-untrust\\")"',
      ),
    ).toBe("tls-refused");
  });

  it("reads a registration that starved", () => {
    expect(
      classifyTunnelSignal('ERR Serve tunnel error error="timeout: no recent network activity"'),
    ).toBe("edge-lost");
    expect(
      classifyTunnelSignal(
        "ERR failed to dial to edge with quic: timeout: no recent network activity",
      ),
    ).toBe("edge-lost");
  });

  it("reads a registration", () => {
    expect(
      classifyTunnelSignal("INF Registered tunnel connection connIndex=0 location=fra01"),
    ).toBe("registered");
  });

  it("ignores ordinary output", () => {
    expect(classifyTunnelSignal("INF Starting tunnel tunnelID=abc")).toBeNull();
  });
});

describe("reduceTunnelHealth", () => {
  it("is connected once the edge accepts a registration", () => {
    expect(run([{ type: "registered", nowMs: 0 }])).toMatchObject({
      status: "connected",
      registered: true,
    });
  });

  it("is blocked by the network after three TLS refusals in a row, and stays so", () => {
    const twice = run([
      { type: "tls-refused", nowMs: 0 },
      { type: "tls-refused", nowMs: 1 },
    ]);
    expect(twice.status).toBe("connecting");
    const blocked = run([{ type: "tls-refused", nowMs: 2 }], twice);
    expect(blocked.status).toBe("blocked-by-network");
    // A late line from the stopped connector must not undo the pause.
    expect(run([{ type: "registered", nowMs: 3 }], blocked).status).toBe("blocked-by-network");
    expect(run([{ type: "spawned", nowMs: 4 }], blocked).status).toBe("blocked-by-network");
  });

  it("counts only consecutive refusals", () => {
    const health = run([
      { type: "tls-refused", nowMs: 0 },
      { type: "tls-refused", nowMs: 1 },
      { type: "registered", nowMs: 2 },
      { type: "tls-refused", nowMs: 3 },
    ]);
    expect(health.status).not.toBe("blocked-by-network");
    expect(health.tlsRefusals).toBe(1);
  });

  it("calls the tunnel unstable when a registration dies within a minute, twice", () => {
    const once = run([
      { type: "registered", nowMs: 0 },
      { type: "edge-lost", nowMs: 30_000 },
    ]);
    expect(once).toMatchObject({ status: "connecting", registered: false, shortRegistrations: 1 });
    const twice = run(
      [
        { type: "registered", nowMs: 40_000 },
        { type: "edge-lost", nowMs: 70_000 },
      ],
      once,
    );
    expect(twice).toMatchObject({ status: "unstable", registered: false });
    // Registered again, still flagged, so the dialog can warn before the QR.
    expect(run([{ type: "registered", nowMs: 80_000 }], twice)).toMatchObject({
      status: "unstable",
      registered: true,
    });
  });

  it("counts several lines about one death once", () => {
    const health = run([
      { type: "registered", nowMs: 0 },
      { type: "edge-lost", nowMs: 20_000 },
      { type: "edge-lost", nowMs: 20_010 },
      { type: "exited", nowMs: 20_020 },
    ]);
    expect(health.shortRegistrations).toBe(1);
  });

  it("forgives a registration that lived a full minute", () => {
    const unstable = run([
      { type: "registered", nowMs: 0 },
      { type: "edge-lost", nowMs: 10_000 },
      { type: "registered", nowMs: 20_000 },
      { type: "edge-lost", nowMs: 30_000 },
      { type: "registered", nowMs: 40_000 },
    ]);
    expect(unstable.status).toBe("unstable");
    expect(run([{ type: "stable", nowMs: 40_000 + SHORT_REGISTRATION_MS - 1 }], unstable)).toBe(
      unstable,
    );
    expect(
      run([{ type: "stable", nowMs: 40_000 + SHORT_REGISTRATION_MS }], unstable),
    ).toMatchObject({ status: "connected", shortRegistrations: 0 });
    const longLived = run([
      { type: "registered", nowMs: 0 },
      { type: "edge-lost", nowMs: SHORT_REGISTRATION_MS },
    ]);
    expect(longLived.shortRegistrations).toBe(0);
  });

  it("starts over on retry", () => {
    const blocked = run([
      { type: "tls-refused", nowMs: 0 },
      { type: "tls-refused", nowMs: 1 },
      { type: "tls-refused", nowMs: 2 },
    ]);
    expect(run([{ type: "retry", nowMs: 3 }], blocked)).toEqual(initialTunnelHealth);
  });
});
