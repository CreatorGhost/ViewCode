// @effect-diagnostics nodeBuiltinImport:off - reads repo manifests to check ViewCode's packaging pins survive a merge.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  MAC_SERVER_RUNTIME_EXTRA_RESOURCE,
  MAC_SERVER_RUNTIME_NODE_MODULES_EXTRA_RESOURCE,
} from "./build-desktop-artifact.ts";

const root = NodePath.join(import.meta.dirname, "..");

// ViewCode guards for the packaged Mac app with the bundled t3 server.
describe("desktop build (ViewCode)", () => {
  // electron-builder always drops a resource's top-level node_modules; without its own
  // entry the bundled t3 server ships without them and dies on launch.
  it("ships the bundled server's node_modules as a resource of their own", () => {
    expect(MAC_SERVER_RUNTIME_NODE_MODULES_EXTRA_RESOURCE).toEqual({
      from: `${MAC_SERVER_RUNTIME_EXTRA_RESOURCE.from}/node_modules`,
      to: `${MAC_SERVER_RUNTIME_EXTRA_RESOURCE.to}/node_modules`,
      filter: ["**/*", "**/node_modules/**/*"],
    });
  });

  // The staged install has no lockfile, so a range floats past the patched version and the
  // install fails with ERR_PNPM_UNUSED_PATCH.
  it("pins node-pty to the version its patch is for", () => {
    const server = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const workspace = NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8");
    const patched = /^\s+node-pty@([^:]+):/m.exec(workspace)?.[1];
    expect(patched).toBeDefined();
    expect(server.dependencies["node-pty"]).toBe(patched);
  });
});
