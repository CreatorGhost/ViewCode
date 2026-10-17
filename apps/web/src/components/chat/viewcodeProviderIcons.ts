import {
  CommandCodeIcon,
  DevinIcon,
  DroidIcon,
  GrokIcon,
  OpenCodeIcon,
  PiIcon,
} from "./viewcodeProviderSvg";
import { ProviderDriverKind } from "@t3tools/contracts";
import { AntigravityIcon, ClaudeAI, CursorIcon, Icon, OpenAI } from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("commandCode")]: CommandCodeIcon,
  [ProviderDriverKind.make("droid")]: DroidIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
  [ProviderDriverKind.make("pi")]: PiIcon,
};
