/** Matches the `normal` preset in viewcode-chat.css; used before styles resolve. */
const FALLBACK_CHAT_COLUMN_MAX_WIDTH_PX = 768;

/**
 * The chat column's max width in pixels, read from `--chat-column-max-width`
 * (rem, so it follows the interface font size). The timeline minimap needs
 * it to tell whether the side gutter is wide enough to sit in.
 */
export function measureChatColumnMaxWidth(element: Element): number {
  const raw = getComputedStyle(element).getPropertyValue("--chat-column-max-width").trim();
  const rem = raw.endsWith("rem") ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(rem)) return FALLBACK_CHAT_COLUMN_MAX_WIDTH_PX;
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return rem * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
}
