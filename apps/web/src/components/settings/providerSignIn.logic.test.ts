import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { signInNeedsServerBrowser } from "./providerSignIn.logic";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");
const base = {
  driver: "codex",
  environmentId: primary,
  primaryEnvironmentId: primary,
  isDesktop: false,
  locationHostname: "localhost",
} as const;

describe("signInNeedsServerBrowser", () => {
  it("is quiet when the browser runs on the machine that signs in", () => {
    expect(signInNeedsServerBrowser(base)).toBe(false);
    expect(signInNeedsServerBrowser({ ...base, isDesktop: true, locationHostname: "" })).toBe(
      false,
    );
  });

  it("warns for a saved remote environment and for a primary reached over the network", () => {
    expect(signInNeedsServerBrowser({ ...base, environmentId: remote })).toBe(true);
    expect(signInNeedsServerBrowser({ ...base, locationHostname: "box.tailnet.ts.net" })).toBe(
      true,
    );
  });

  it("only applies to Codex's browser login", () => {
    expect(
      signInNeedsServerBrowser({ ...base, driver: "claudeAgent", environmentId: remote }),
    ).toBe(false);
  });
});
