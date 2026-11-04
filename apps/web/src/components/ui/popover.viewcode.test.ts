import { describe, expect, it } from "vite-plus/test";

import { popoverPopupVariantClassName } from "./popover";

// The composer's model and usage cards hang off a pill as a rounder sheet with a caret
// that grows from the pill as it fades in. Upstream's popover knows "default" and "panel".
describe("floating popover variant", () => {
  it("is a rounder sheet that scales in", () => {
    const classes = popoverPopupVariantClassName.floating;
    expect(classes).toContain("rounded-3xl");
    expect(classes).toContain("motion-safe:data-starting-style:scale-[0.96]");
    expect(classes).toContain("transition-[width,height,translate,scale,opacity]");
  });
});
