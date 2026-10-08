import {
  ChatDensity,
  ChatWidth,
  DEFAULT_CHAT_DENSITY,
  DEFAULT_CHAT_WIDTH,
  type ChatDensity as ChatDensityValue,
  type ChatWidth as ChatWidthValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * ViewCode chat transcript appearance. The values land on `<html>` as data
 * attributes; `viewcode-chat.css` turns them into the `max-w-chat` column and
 * the row gaps, so no component re-renders when a preset changes.
 */

export const CHAT_DENSITY_OPTIONS: ReadonlyArray<{ value: ChatDensityValue; label: string }> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

export const CHAT_WIDTH_OPTIONS: ReadonlyArray<{ value: ChatWidthValue; label: string }> = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

const isChatDensity = Schema.is(ChatDensity);
const isChatWidth = Schema.is(ChatWidth);

export function normalizeChatDensity(value: unknown): ChatDensityValue {
  return isChatDensity(value) ? value : DEFAULT_CHAT_DENSITY;
}

export function normalizeChatWidth(value: unknown): ChatWidthValue {
  return isChatWidth(value) ? value : DEFAULT_CHAT_WIDTH;
}

/** Data attributes `ChatAppearanceSync` writes onto the document element. */
export function chatAppearanceDataset(input: { chatDensity: unknown; chatWidth: unknown }): {
  chatDensity: ChatDensityValue;
  chatWidth: ChatWidthValue;
} {
  return {
    chatDensity: normalizeChatDensity(input.chatDensity),
    chatWidth: normalizeChatWidth(input.chatWidth),
  };
}

// ── Long user messages ──────────────────────────────────────────────

/** A user message taller than this many lines folds behind "Show more". */
export const USER_MESSAGE_COLLAPSED_MAX_LINES = 12;
/**
 * First-paint hint for messages that wrap into many lines without newlines.
 * Roughly 12 lines of the default column at the default prompt font.
 */
export const USER_MESSAGE_COLLAPSED_MAX_CHARS = 1200;

/**
 * Whether a user message should start folded. Counts newlines without
 * splitting the string: long pastes are exactly the messages this runs on.
 */
export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false;
  if (text.length > USER_MESSAGE_COLLAPSED_MAX_CHARS) return true;
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > USER_MESSAGE_COLLAPSED_MAX_LINES) return true;
  }
  return false;
}
