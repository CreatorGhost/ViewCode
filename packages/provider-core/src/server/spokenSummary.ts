import * as Schema from "effect/Schema";

// ViewCode speak mode: the spoken summary of a finished turn's reply.

export const SPOKEN_SUMMARY_MAX_WORDS = 60;
const SPOKEN_SUMMARY_MAX_SENTENCES = 4;
// The opening says what was asked and the end says how it went; the middle of a
// long reply is usually detail nobody wants read aloud.
const MAX_REPLY_EDGE_CHARS = 6_000;

const SPOKEN_SUMMARY_PROMPT = `A coding agent just finished a turn. Its final reply to the user is below.
Write what a colleague would say out loud to tell the user how the turn went.
Return a JSON object with key: summary.

Rules:
- 3 or 4 short, plain sentences, at most ${SPOKEN_SUMMARY_MAX_WORDS} words in total.
- Spoken prose only: no code, commands, file contents, markdown, lists, headings, links or emoji.
- Lead with the outcome, then anything the user has to decide or do next.
- Mention a file or identifier only when it matters, written as it would be said.
- Use only what the reply says. Do not invent results.`;

export function buildSpokenSummaryPrompt(input: { readonly message: string }) {
  const reply =
    input.message.length <= MAX_REPLY_EDGE_CHARS * 2
      ? input.message
      : `${input.message.slice(0, MAX_REPLY_EDGE_CHARS)}\n\n[Middle of the reply omitted]\n\n${input.message.slice(-MAX_REPLY_EDGE_CHARS)}`;
  return {
    prompt: `${SPOKEN_SUMMARY_PROMPT}\n\nReply:\n${reply}`,
    outputSchema: Schema.Struct({ summary: Schema.String }),
  };
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Small models ignore formatting rules often enough that the summary is
 * stripped to prose and capped here too: a text-to-speech voice reads every
 * backtick and asterisk it is given.
 */
export function sanitizeSpokenSummary(raw: string): string {
  const lines = raw
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+•]\s+|\d+[.)]\s+)/, "")
        .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2")
        .replace(/[`*#|<>~]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  // A list item or heading has no closing punctuation; joined bare, it runs
  // into the next line as one breathless sentence.
  const prose = lines.map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`)).join(" ");

  const sentences = Array.from(
    new Intl.Segmenter("en", { granularity: "sentence" }).segment(prose),
    ({ segment }) => segment.trim(),
  ).filter(Boolean);
  const kept: Array<string> = [];
  let words = 0;
  for (const sentence of sentences.slice(0, SPOKEN_SUMMARY_MAX_SENTENCES)) {
    const count = wordCount(sentence);
    if (words + count > SPOKEN_SUMMARY_MAX_WORDS) {
      if (kept.length === 0) {
        const cut = sentence
          .split(/\s+/)
          .slice(0, SPOKEN_SUMMARY_MAX_WORDS)
          .join(" ")
          .replace(/[\s,;:.!?-]+$/, "");
        kept.push(`${cut}.`);
      }
      break;
    }
    kept.push(sentence);
    words += count;
  }
  return kept.join(" ");
}
