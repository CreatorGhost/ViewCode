import { useEffect } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { chatAppearanceDataset } from "./chatAppearance";

/** Mirrors the chat density and width settings onto `<html>` for viewcode-chat.css. */
export function ChatAppearanceSync() {
  const chatDensity = useClientSettings((settings) => settings.chatDensity);
  const chatWidth = useClientSettings((settings) => settings.chatWidth);

  useEffect(() => {
    const dataset = document.documentElement.dataset;
    const next = chatAppearanceDataset({ chatDensity, chatWidth });
    dataset.chatDensity = next.chatDensity;
    dataset.chatWidth = next.chatWidth;
  }, [chatDensity, chatWidth]);

  return null;
}
