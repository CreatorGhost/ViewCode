import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("does not resolve registry icons for other provider drivers", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });
});

describe("ViewCode provider brand icons", () => {
  it.each([
    ["commandCode", "Command Code"],
    ["droid", "Droid"],
    ["devin", "Devin"],
  ])("renders the %s brand rather than provider initials", async (driver, displayName) => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ProviderInstanceIcon, {
          driverKind: ProviderDriverKind.make(driver),
          displayName,
        }),
      );
    });
    try {
      expect(renderer.root.findAllByType("svg")).toHaveLength(1);
      expect(renderer.root.findAllByType("path").length).toBeGreaterThan(0);
      expect(
        renderer.root
          .findAllByType("span")
          .flatMap((span) => span.children.filter((child) => typeof child === "string")),
      ).toEqual([]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  it("keeps initials for unrecognized custom drivers", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ProviderInstanceIcon, {
          driverKind: ProviderDriverKind.make("custom-runtime"),
          displayName: "Custom Runtime",
        }),
      );
    });
    try {
      expect(renderer.root.findAllByType("svg")).toHaveLength(0);
      expect(
        renderer.root
          .findAllByType("span")
          .flatMap((span) => span.children.filter((child) => typeof child === "string")),
      ).toEqual(["CR"]);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
