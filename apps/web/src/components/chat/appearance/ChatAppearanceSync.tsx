import { useEffect } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { chatAppearanceDataset } from "./chatAppearance";

/**
 * Mirrors the chat density and width settings onto `<html>` for viewcode-chat.css, and
 * whether the composer glows while a turn runs.
 */
export function ChatAppearanceSync() {
  const chatDensity = useClientSettings((settings) => settings.chatDensity);
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const composerGlow = useClientSettings((settings) => settings.composerGlow);

  useEffect(() => {
    const dataset = document.documentElement.dataset;
    const next = chatAppearanceDataset({ chatDensity, chatWidth });
    dataset.chatDensity = next.chatDensity;
    dataset.chatWidth = next.chatWidth;
    dataset.composerGlow = composerGlow ? "on" : "off";
  }, [chatDensity, chatWidth, composerGlow]);

  return null;
}
