import { describe, expect, it } from "vite-plus/test";

import { standaloneDiagramSvg } from "./diagramExport";

describe("standaloneDiagramSvg", () => {
  const rendered =
    '<svg id="d0" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 120px;" viewBox="-8 -8 120 60" role="graphics-document document"><style>#d0 .node rect{fill:#123}</style><g><rect class="basic" stroke-width="1.5" width="10" height="10"/></g></svg>';

  it("sizes the file from its viewBox and paints the canvas behind the diagram", () => {
    expect(standaloneDiagramSvg(rendered, "#19191b")).toBe(
      '<svg id="d0" xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 120 60" role="graphics-document document" width="120" height="60">' +
        '<rect x="-8" y="-8" width="120" height="60" style="fill:#19191b;stroke:none"/>' +
        '<style>#d0 .node rect{fill:#123}</style><g><rect class="basic" stroke-width="1.5" width="10" height="10"/></g></svg>',
    );
  });

  it("adds the SVG namespace when the markup lacks it", () => {
    expect(standaloneDiagramSvg('<svg viewBox="0 0 10 20"><g/></svg>', "#fff")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" width="10" height="20"><rect x="0" y="0" width="10" height="20" style="fill:#fff;stroke:none"/><g/></svg>',
    );
  });

  it("refuses markup without a usable viewBox", () => {
    expect(standaloneDiagramSvg('<svg width="100%"><g/></svg>', "#fff")).toBeNull();
    expect(standaloneDiagramSvg('<svg viewBox="0 0 0 20"><g/></svg>', "#fff")).toBeNull();
    expect(standaloneDiagramSvg("<div></div>", "#fff")).toBeNull();
  });
});
