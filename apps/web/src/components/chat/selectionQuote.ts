/** The selected reply text as a markdown blockquote, ready to prefill a composer. */
export function quoteForComposer(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}
