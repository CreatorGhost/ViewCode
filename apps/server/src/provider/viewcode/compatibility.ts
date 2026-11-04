import type { ProviderCompatibilityPolicy } from "../providerCompatibility.ts";

// These runtimes negotiate capabilities at connection time. No CLI release range
// has been certified, so version advice must stay unknown rather than imply support.
export const VIEWCODE_PROVIDER_COMPATIBILITY: ReadonlyArray<ProviderCompatibilityPolicy> = [
  { driver: "commandCode", t3CodeRange: ">=0.0.46", ranges: [] },
  { driver: "droid", t3CodeRange: ">=0.0.46", ranges: [] },
  { driver: "devin", t3CodeRange: ">=0.0.46", ranges: [] },
];
