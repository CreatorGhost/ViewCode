import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isLegalDocumentUrl, LEGAL_URL } from "./legal-document-url";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("isLegalDocumentUrl", () => {
  it("has no legal URL until a website is configured", () => {
    expect(LEGAL_URL).toBeNull();
  });
  it.each([
    "https://t3.codes/legal",
    "https://t3.codes/legal/",
    "https://t3.codes/privacy-policy?source=app",
    "https://t3.codes/terms-of-service#updates",
    "https://t3.codes/security-policy",
  ])("does not link to T3 legal documents by default: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });

  it.each([
    "https://t3.codes/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});

it("uses the configured website when one is added", async () => {
  vi.stubEnv("EXPO_PUBLIC_MARKETING_SITE_URL", "https://example.com/");
  vi.resetModules();
  const legal = await import("./legal-document-url");
  expect(legal.LEGAL_URL).toBe("https://example.com/legal");
  expect(legal.isLegalDocumentUrl("https://example.com/legal")).toBe(true);
  expect(legal.isLegalDocumentUrl("https://t3.codes/legal")).toBe(false);
});
