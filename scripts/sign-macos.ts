import * as NodeURL from "node:url";

import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

// The bundled standalone server (resources/t3-server/t3) is a Node, not an
// Electron helper: it gets the entitlements its own CLI release is signed with.
const BUNDLED_SERVER_EXECUTABLE_SUFFIX = "/Contents/Resources/t3-server/t3";
const CLI_ENTITLEMENTS = NodeURL.fileURLToPath(
  new URL("../apps/server/resources/cli-entitlements.plist", import.meta.url),
);

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  const optionsForFile = options.optionsForFile;
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    optionsForFile: (filePath, fileOptions) => {
      const base = optionsForFile?.(filePath, fileOptions) ?? {};
      return filePath.endsWith(BUNDLED_SERVER_EXECUTABLE_SUFFIX)
        ? { ...base, entitlements: CLI_ENTITLEMENTS }
        : base;
    },
  });
}
