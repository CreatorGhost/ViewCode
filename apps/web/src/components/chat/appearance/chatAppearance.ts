import {
  ChatDensity,
  DEFAULT_CHAT_DENSITY,
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

export function normalizeChatDensity(value: unknown): ChatDensityValue {
  return isChatDensity(value) ? value : DEFAULT_CHAT_DENSITY;
}
