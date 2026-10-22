export const viewcodeProductPolicy = {
  homeDirectoryName: ".viewcode",
  // T3 Code's default home. Its app may still be installed and running, so
  // ViewCode only ever reads from it.
  upstreamHomeDirectoryName: ".t3",
  nativeProviderGoalUi: false,
  inlineThreadDetails: false,
  nativeCliManagedRuntime: false,
  nativeUsageRecoveryUi: false,
  doctor: false,
  installCliFromSettings: false,
  upstreamPromotions: false,
  upstreamMobileCompiler: false,
  anonymousUsageOnboarding: false,
  anonymousTelemetryEnabled: false,
  anonymousTelemetryKey: "",
} as const;
