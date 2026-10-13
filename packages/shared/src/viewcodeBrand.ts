/** Geometry shared by the native and web marks; the standalone artwork is assets/viewcode-mark.svg. */
export const VIEWCODE_MARK = {
  viewBox: "240 224 544 588",
  aspectRatio: 544 / 588,
  leftPath: "M318 300 L512 736",
  rightPath: "M706 300 L512 736",
  strokeWidth: 116,
  cutStrokeWidth: 166,
  outlineStrokeWidth: 140,
  black: "#000000",
  // ViewCode Teal's default accent, kept independent of the active UI palette.
  teal: "#23c5b3",
} as const;
