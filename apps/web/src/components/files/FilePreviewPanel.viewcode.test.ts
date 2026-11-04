// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const panel = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "FilePreviewPanel.tsx"),
  "utf8",
);

/** The source of one top-level preview component, up to the next one. */
function component(name: string): string {
  const start = panel.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = panel.indexOf("\nfunction ", start + 1);
  return panel.slice(start, end === -1 ? undefined : end);
}

// ViewCode guard: the server's workspace asset route refuses a path outside the project root, so
// an image outside the project (a screenshot an agent saved to /tmp) read "Unable to load
// workspace image." until the image preview used the media route for it, as the browser preview
// does. Rendering the panel needs the whole app, so this checks the wiring itself.
describe("file preview of an image outside the project (ViewCode)", () => {
  it("asks for an image outside the workspace through the media route", () => {
    expect(component("WorkspaceImagePreview")).toContain(
      'kind: insideWorkspace ? "workspace-file" : "media-file"',
    );
  });
});
