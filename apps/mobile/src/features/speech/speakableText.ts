import type { SpeakMode } from "@t3tools/contracts";

const SKIPPED_CODE_BLOCK = "Code block skipped.";
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// Android's TextToSpeech rejects longer input (Speech.maxSpeechInputLength is 4000).
const MAX_CHUNK_LENGTH = 3_000;

/**
 * A reply's markdown as plain prose for the system voice: code blocks (and diagrams) are announced
 * as skipped, links read as their text, and images, HTML and markup are dropped.
 */
export function speakableText(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
    paragraph = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      flush();
      blocks.push(SKIPPED_CODE_BLOCK);
      fence = opener;
      continue;
    }
    const text = speakableLine(line);
    if (text === null) flush();
    else if (TABLE_ROW.test(line)) {
      // Each table row reads as its own sentence.
      flush();
      blocks.push(text);
    } else paragraph.push(text);
  }
  flush();
  return blocks.join("\n\n");
}

/** One markdown line as prose, or null for a line that ends a paragraph. */
function speakableLine(line: string): string | null {
  if (/^\s*$/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return null;
  // Table separator rows carry no words.
  if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line)) return null;
  let text = line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, "$1$2");
  if (TABLE_ROW.test(text)) {
    text = text
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", ");
  }
  return text.trim().length > 0 ? text.trim() : null;
}

/** Pieces short enough for the platform voice, split at paragraphs, then sentences. */
export function speechChunks(text: string, maxLength = MAX_CHUNK_LENGTH): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    let rest = paragraph.trim();
    while (rest.length > maxLength) {
      const window = rest.slice(0, maxLength);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
      const end = cut > 0 ? cut + 1 : maxLength;
      chunks.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

/** What speak mode reads for a finished reply, or null while there is nothing to read yet. */
export function spokenTextForReply(
  mode: SpeakMode,
  reply: { readonly text: string; readonly spokenSummary?: string | undefined },
): string | null {
  if (mode === "summary") return reply.spokenSummary?.trim() || null;
  if (mode === "full") return speakableText(reply.text) || null;
  return null;
}

/**
 * The reply speak mode should read now: a reply other than the last one handled, once its text
 * to read exists (a summary arrives after the turn ends).
 */
export function replyToSpeak(input: {
  readonly mode: SpeakMode;
  readonly reply: {
    readonly id: string;
    readonly text: string;
    readonly spokenSummary?: string | undefined;
  } | null;
  readonly handledId: string | null;
}): { readonly id: string; readonly text: string } | null {
  if (input.reply === null || input.reply.id === input.handledId) return null;
  const text = spokenTextForReply(input.mode, input.reply);
  return text === null ? null : { id: input.reply.id, text };
}
