import * as NodeModule from "node:module";

import type * as UndiciModule from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
export const Undici = NodeModule.createRequire(import.meta.url)("undici") as typeof UndiciModule;
