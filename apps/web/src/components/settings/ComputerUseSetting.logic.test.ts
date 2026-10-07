import { describe, expect, it } from "vite-plus/test";
import type { ComputerUseStatus } from "@t3tools/contracts";

import { describeComputerUseStatus } from "./ComputerUseSetting.logic";

const status = (overrides: Partial<ComputerUseStatus> = {}): ComputerUseStatus => ({
  mode: "control",
  platform: "darwin",
  driverAvailable: true,
  accessibility: "granted",
  ...overrides,
});

describe("describeComputerUseStatus", () => {
  it("is ready only when the driver runs and Accessibility is granted", () => {
    expect(describeComputerUseStatus(status())).toEqual({
      ready: true,
      message: "Accessibility granted. Screenshots also need Screen Recording.",
    });
    expect(describeComputerUseStatus(status({ accessibility: "unknown" })).ready).toBe(false);
  });

  it("explains where to grant Accessibility on macOS", () => {
    const result = describeComputerUseStatus(status({ accessibility: "denied" }));
    expect(result.ready).toBe(false);
    expect(result.message).toContain("System Settings → Privacy & Security → Accessibility");
  });

  it("prefers the server's reason when the driver is unavailable", () => {
    expect(
      describeComputerUseStatus(
        status({ driverAvailable: false, platform: "linux", reason: "No display server." }),
      ).message,
    ).toBe("No display server.");
    expect(
      describeComputerUseStatus(status({ driverAvailable: false, platform: "linux" })).message,
    ).toContain("linux");
  });

  it("does not send non-macOS users to System Settings", () => {
    expect(
      describeComputerUseStatus(status({ platform: "linux", accessibility: "denied" })).message,
    ).not.toContain("System Settings");
  });
});
