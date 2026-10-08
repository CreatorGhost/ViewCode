import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { deriveUnsettledTurnId } from "../components/chat/MessagesTimeline.logic";
import type { ChatMessage, Thread } from "../types";

/** Chromium's speechSynthesis can cut off long utterances, so each one stays short. */
export const READ_ALOUD_MAX_CHUNK_LENGTH = 250;

const SKIPPED_CODE_BLOCK = "Code block skipped.";
const URL_LIKE_TEXT = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const GITHUB_ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\]\s*/i;
const TERMINAL_PUNCTUATION = /[.!?…:;]["'”’)\]]*$/;

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** Messages are keyed per thread: forks can carry the same message ids. */
export function readAloudMessageKey(threadKey: string, messageId: string): string {
  return `${threadKey}:${messageId}`;
}

/**
 * The prose of an assistant reply as speakable blocks (one per paragraph, heading,
 * list item or table row). Code and diagrams are announced as skipped, links read
 * as their text, images and raw HTML are dropped.
 */
export function speakableBlocksFromMarkdown(markdown: string): string[] {
  const blocks: string[] = [];
  collectBlocks(markdownParser.parse(markdown), blocks);
  return blocks;
}

function collectBlocks(node: Nodes, blocks: string[]): void {
  switch (node.type) {
    case "code":
      blocks.push(SKIPPED_CODE_BLOCK);
      return;
    case "paragraph":
    case "heading":
      pushBlock(blocks, inlineText(node));
      return;
    case "tableRow":
      pushBlock(blocks, node.children.map(inlineText).filter(Boolean).join(", "));
      return;
    case "blockquote": {
      const start = blocks.length;
      for (const child of node.children) collectBlocks(child, blocks);
      // GitHub alerts (`> [!NOTE]`) read as their label.
      const first = blocks[start];
      const alert = first ? GITHUB_ALERT_MARKER.exec(first) : null;
      if (first && alert) {
        const label = `${alert[1]!.charAt(0).toUpperCase()}${alert[1]!.slice(1).toLowerCase()}.`;
        const rest = first.slice(alert[0].length);
        blocks[start] = rest.length > 0 ? `${label} ${rest}` : label;
      }
      return;
    }
    case "root":
    case "list":
    case "listItem":
    case "table":
      for (const child of node.children) collectBlocks(child, blocks);
      return;
    default:
      // Thematic breaks, raw HTML, definitions, footnotes and front matter are not prose.
      return;
  }
}

function inlineText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return " ";
    case "image":
    case "imageReference":
    case "html":
    case "footnoteReference":
      return "";
    case "link":
    case "linkReference": {
      const text = node.children.map(inlineText).join("").trim();
      // A bare URL is noise read aloud; prose around it still makes sense.
      return URL_LIKE_TEXT.test(text) ? "link" : text;
    }
    default:
      return "children" in node ? node.children.map(inlineText).join("") : "";
  }
}

function pushBlock(blocks: string[], raw: string): void {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return;
  // Headings, list items and table rows rarely end in punctuation; without it
  // the voice runs straight into the next block.
  blocks.push(TERMINAL_PUNCTUATION.test(text) ? text : `${text}.`);
}

/**
 * Packs blocks into utterances of at most `maxLength` characters, breaking only
 * between sentences unless a single sentence is longer than that.
 */
export function chunkSpeakableBlocks(
  blocks: ReadonlyArray<string>,
  maxLength = READ_ALOUD_MAX_CHUNK_LENGTH,
): string[] {
  const sentences = blocks.flatMap((block) => block.split(/(?<=[.!?…]["'”’)\]]*)\s+/));
  return packPieces(
    sentences.flatMap((sentence) => splitToFit(sentence, maxLength)),
    maxLength,
  );
}

function splitToFit(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  for (const separator of [/(?<=[,;:])\s+/, /\s+/]) {
    const parts = text.split(separator);
    if (parts.length > 1) {
      return packPieces(
        parts.flatMap((part) => splitToFit(part, maxLength)),
        maxLength,
      );
    }
  }
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    pieces.push(text.slice(index, index + maxLength));
  }
  return pieces;
}

function packPieces(pieces: ReadonlyArray<string>, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    if (current.length === 0) {
      current = piece;
    } else if (current.length + 1 + piece.length <= maxLength) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Utterances for a message's Markdown source; Codex directives read as Copy renders them. */
export function readAloudChunks(markdown: string): string[] {
  return chunkSpeakableBlocks(speakableBlocksFromMarkdown(renderCodexDirectivesForCopy(markdown)));
}

interface VoiceChoice {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
}

/**
 * Voices offered in Settings: those speaking the user's language (their exact
 * locale first), or every voice when none does. The saved voice always stays listed.
 */
export function readAloudVoiceChoices<Voice extends VoiceChoice>(
  voices: ReadonlyArray<Voice>,
  language: string,
  selectedVoiceURI: string | null,
): Voice[] {
  const normalize = (lang: string) => lang.toLowerCase().replace("_", "-");
  const locale = normalize(language);
  const primary = locale.split("-")[0];
  const matching = voices.filter(
    (voice) =>
      normalize(voice.lang).split("-")[0] === primary || voice.voiceURI === selectedVoiceURI,
  );
  const choices = matching.some((voice) => voice.voiceURI !== selectedVoiceURI)
    ? matching
    : [...voices];
  const rank = (voice: Voice) => (normalize(voice.lang) === locale ? 0 : 1);
  return choices.toSorted(
    (left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name),
  );
}

/**
 * The reply the "Read latest reply aloud" command reads: the final assistant
 * message of the newest settled response. Progress updates written mid-turn and
 * a reply still streaming are never picked.
 */
export function latestReadableReply(
  thread: Pick<Thread, "messages" | "latestTurn" | "session">,
): ChatMessage | null {
  const runningTurnId =
    (thread.session?.status === "running" ? thread.session.activeTurnId : null) ??
    (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
  const unsettledTurnId = deriveUnsettledTurnId(thread.latestTurn, runningTurnId);
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.role !== "assistant") continue;
    if (message.streaming || (message.turnId != null && message.turnId === unsettledTurnId)) {
      continue;
    }
    return message.text.trim().length > 0 ? message : null;
  }
  return null;
}
