import { describe, expect, it } from "vite-plus/test";

import { buttonVariants } from "./button";

// ViewCode's look lives in Button variants upstream does not have. A merge that takes
// upstream's variant table drops them, and every caller falls back to the default look.
describe("ViewCode button variants", () => {
  it.each([
    ["chip", "text-muted-foreground"],
    ["chip-outline", "border-foreground/12"],
    ["header", "bg-foreground/8"],
    ["primary-solid", "bg-foreground"],
    ["primary-soft", "bg-primary/10"],
  ] as const)("keeps the %s variant", (variant, marker) => {
    expect(buttonVariants({ variant })).toContain(marker);
  });

  it("keeps the chip and header icon sizes", () => {
    expect(buttonVariants({ size: "icon-chip" })).toContain("vc-chip");
    expect(buttonVariants({ size: "icon-header" })).toContain("size-9");
  });

  it("greys a disabled soft primary pill in both appearances", () => {
    const classes = buttonVariants({ variant: "primary-soft" });
    expect(classes).toContain("disabled:bg-foreground/6");
    expect(classes).toContain("dark:disabled:bg-foreground/6");
  });
});
