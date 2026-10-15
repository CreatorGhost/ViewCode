import * as NodeURL from "node:url";

/**
 * Loads an ESM package through `require`, which external packages need
 * because a static `import` of one fails inside the single executable.
 *
 * The workspace patches give such packages a `require` export condition, but
 * an `npm install` of the published package gets the upstream manifests,
 * whose exports map may offer only `import`. Then the entry is resolved the
 * ESM way and required by path, which Node allows for ES modules.
 */
export function requireEsmOnlyPackage<T>(
  require: NodeJS.Require,
  resolveImport: (specifier: string) => string,
  specifier: string,
): T {
  try {
    return require(specifier) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return require(NodeURL.fileURLToPath(resolveImport(specifier))) as T;
  }
}
