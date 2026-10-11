/** Longest selection preview, shared by the citation chip label and the composer quote. */
export const SELECTION_PREVIEW_MAX_LENGTH = 64;

/** The selection collapsed onto one line, truncated with an ellipsis when long. */
export function selectionPreview(text: string): string {
  const preview = text.replace(/\s+/g, " ").trim();
  return preview.length > SELECTION_PREVIEW_MAX_LENGTH
    ? `${preview.slice(0, SELECTION_PREVIEW_MAX_LENGTH)}…`
    : preview;
}

/** The selected reply text as a one-line markdown blockquote, ready to prefill a composer. */
export function quoteForComposer(text: string): string {
  return `> ${selectionPreview(text)}\n\n`;
}
