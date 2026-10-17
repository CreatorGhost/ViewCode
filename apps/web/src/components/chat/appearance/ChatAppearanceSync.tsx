import { useEffect } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { normalizeChatDensity } from "./chatAppearance";

/**
 * Mirrors ViewCode density and composer glow onto `<html>`. Native appearance sync owns width.
 */
export function ChatAppearanceSync() {
  const chatDensity = useClientSettings((settings) => settings.chatDensity);
  const composerGlow = useClientSettings((settings) => settings.composerGlow);

  useEffect(() => {
    const dataset = document.documentElement.dataset;
    dataset.chatDensity = normalizeChatDensity(chatDensity);
    dataset.composerGlow = composerGlow ? "on" : "off";
  }, [chatDensity, composerGlow]);

  return null;
}
