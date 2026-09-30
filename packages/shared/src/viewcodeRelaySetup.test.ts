import { describe, expect, it } from "vite-plus/test";

import {
  classifyProbeError,
  classifyProbeStatus,
  detectMissingWorkersDevSubdomain,
  detectWorkerAlreadyDeleted,
  deviceLoginOpenUrl,
  parseDeviceLoginPrompt,
  redactSecrets,
} from "./viewcodeRelaySetup.ts";

// What `wrangler login --device --browser=false` prints (wrangler 4.144), colours included.
const DEVICE_LOGIN_OUTPUT = [
  "\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Proxy environment variables detected.",
  "",
  "To authorize Wrangler, please visit:",
  "",
  "  https://dash.cloudflare.com/oauth2/device",
  "",
  "and enter the code:",
  "",
  "  WDJB-MJHT",
  "",
  "You have 10 minutes to approve this request.",
  "",
].join("\n");

describe("parseDeviceLoginPrompt", () => {
  it("reads the link and code from wrangler's device sign-in output", () => {
    const prompt = parseDeviceLoginPrompt(DEVICE_LOGIN_OUTPUT);
    expect(prompt).toEqual({ url: "https://dash.cloudflare.com/oauth2/device", code: "WDJB-MJHT" });
    expect(deviceLoginOpenUrl(prompt)).toBe(
      "https://dash.cloudflare.com/oauth2/device?user_code=WDJB-MJHT",
    );
  });

  it("shows the link before the code has streamed in, and nothing it cannot trust", () => {
    const partial = DEVICE_LOGIN_OUTPUT.slice(0, DEVICE_LOGIN_OUTPUT.indexOf("and enter"));
    expect(parseDeviceLoginPrompt(partial)).toEqual({
      url: "https://dash.cloudflare.com/oauth2/device",
      code: null,
    });
    expect(
      parseDeviceLoginPrompt("please visit:\n  https://evil.example/oauth2/device\n").url,
    ).toBeNull();
    expect(parseDeviceLoginPrompt("Something else entirely")).toEqual({ url: null, code: null });
  });
});

describe("detectMissingWorkersDevSubdomain", () => {
  it("spots wrangler's missing subdomain error and nothing else", () => {
    expect(
      detectMissingWorkersDevSubdomain(
        "✘ [ERROR] You need to register a workers.dev subdomain before publishing to workers.dev",
      ),
    ).toBe(true);
    expect(
      detectMissingWorkersDevSubdomain(
        "Uploaded viewcode-relay\n  https://viewcode-relay.me.workers.dev",
      ),
    ).toBe(false);
  });
});

describe("detectWorkerAlreadyDeleted", () => {
  it("treats a Worker that is already gone as deleted, not an auth failure", () => {
    expect(
      detectWorkerAlreadyDeleted("This Worker does not exist on your account. [code: 10007]"),
    ).toBe(true);
    expect(detectWorkerAlreadyDeleted("Authentication error [code: 10000]")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("removes every occurrence of each secret and leaves other text alone", () => {
    const secret = "k3y-ABCDEFGHIJ_secret";
    expect(redactSecrets(`echo ${secret} and ${secret}!`, [secret, null])).toBe(
      "echo [redacted] and [redacted]!",
    );
    expect(redactSecrets("nothing here", [secret])).toBe("nothing here");
  });
});

describe("probe classification", () => {
  it("counts only the Worker's 426 as proof, and tells the three failures apart", () => {
    expect(classifyProbeStatus(426)).toEqual({ kind: "ok" });
    expect(classifyProbeStatus(401)).toMatchObject({ problem: "credential-rejected" });
    expect(classifyProbeStatus(403)).toMatchObject({ problem: "credential-rejected" });
    expect(classifyProbeStatus(503)).toMatchObject({ problem: "transient" });
    expect(classifyProbeStatus(404)).toMatchObject({ problem: "transient" });
    expect(
      classifyProbeError("TypeError: fetch failed: ECONNRESET: read ECONNRESET"),
    ).toMatchObject({ problem: "network-refused" });
    expect(
      classifyProbeError(
        "Client network socket disconnected before secure TLS connection was established",
      ),
    ).toMatchObject({ problem: "network-refused" });
    expect(
      classifyProbeError("ENOTFOUND: getaddrinfo ENOTFOUND relay.me.workers.dev"),
    ).toMatchObject({ problem: "transient" });
    expect(classifyProbeError("ETIMEDOUT: no answer within 10s")).toMatchObject({
      problem: "transient",
    });
  });
});
