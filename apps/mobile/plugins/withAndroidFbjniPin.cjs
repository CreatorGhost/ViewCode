const { withProjectBuildGradle } = require("expo/config-plugins");

// react-native-shiki-engine depends on `com.facebook.fbjni:fbjni:+`, which
// resolves to the newest fbjni. Newer fbjni is built against a newer libc++
// than React Native ships, so release builds crash at launch with
// "couldn't find DSO to load: libfbjni.so" (__cxa_init_primary_exception).
// Pin fbjni to the version React Native itself uses.
const FBJNI_VERSION = "0.7.0";
const MARKER = "// withAndroidFbjniPin";

module.exports = function withAndroidFbjniPin(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (!nextConfig.modResults.contents.includes(MARKER)) {
      nextConfig.modResults.contents += `
${MARKER}
allprojects {
  configurations.all {
    resolutionStrategy.force "com.facebook.fbjni:fbjni:${FBJNI_VERSION}"
  }
}
`;
    }
    return nextConfig;
  });
};
