import type { SettingsSearchItem } from "./settingsSearch";

export const VIEWCODE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "window-transparency",
    title: "Window transparency",
    to: "/settings/appearance",
    searchTerms: ["see-through translucent vibrancy mica blur desktop background"],
    desktopOnly: true,
  },
  {
    id: "chat-density",
    title: "Chat density",
    to: "/settings/appearance",
    searchTerms: ["compact comfortable spacing transcript messages rows gap"],
  },
  {
    id: "collapse-finished-turns",
    title: "Collapse finished turns",
    to: "/settings/appearance",
    searchTerms: ["fold tool calls commands work summary worked for transcript"],
  },
  {
    id: "project-color-tint",
    title: "Colour the app with the active project",
    to: "/settings/appearance",
    searchTerms: ["project color colour tint sidebar accent"],
  },
  {
    id: "composer-glow",
    title: "Composer glow",
    to: "/settings/appearance",
    searchTerms: ["glow halo composer running working light accent"],
  },
  {
    id: "header-actions",
    title: "Actions and Git in the top bar",
    to: "/settings/appearance",
    searchTerms: ["add action scripts commit push pull request header toolbar buttons hide"],
  },
  {
    id: "read-aloud-engine",
    title: "Read aloud engine",
    to: "/settings/appearance",
    searchTerms: [
      "speak speech text to speech tts natural voice kokoro download model offline remove system",
    ],
  },
  {
    id: "read-aloud-voice",
    title: "Read aloud voice",
    to: "/settings/appearance",
    searchTerms: ["speak speech text to speech tts listen voices system preview"],
  },
  {
    id: "read-aloud-speed",
    title: "Read aloud speed",
    to: "/settings/appearance",
    searchTerms: ["speak speech text to speech tts rate fast slow"],
  },
  {
    id: "dictation",
    title: "Dictation",
    to: "/settings/appearance",
    searchTerms: [
      "dictate voice input speech to text microphone mic transcribe moonshine download model offline remove",
    ],
  },
  {
    id: "resume-after-usage-limit",
    title: "Resume automatically after usage limits reset",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "quota rate limit five hour 5-hour weekly continue resume reset away claude codex",
    ],
  },
  {
    id: "keep-awake-for-usage-resume",
    title: "Keep the computer awake until then",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["sleep suspend power usage limit resume desktop lid"],
  },
  {
    id: "claude-keychain-usage",
    title: "Claude account usage",
    to: "/settings/providers",
    searchTerms: ["claude macOS keychain banked resets reset credits login permission"],
    providerSettingsOnly: true,
    macProviderSettingsOnly: true,
  },
  {
    id: "computer-use",
    title: "Computer use",
    to: "/settings/integrations",
    searchTerms: [
      "agent see operate control apps screen screenshot accessibility desktop mouse keyboard observe approval",
    ],
  },
  {
    id: "computer-use-approvals",
    title: "Ask before computer input",
    to: "/settings/integrations",
    searchTerms: [
      "computer use approval ask permission risky never thread full access click type confirm",
    ],
  },
  {
    id: "computer-use-screen",
    title: "Show on screen",
    to: "/settings/integrations",
    searchTerms: [
      "computer use show on screen background front focus raise window ask once per task",
    ],
  },
  {
    id: "computer-use-activity",
    title: "Recent actions",
    to: "/settings/integrations",
    environmentOnly: true,
    searchTerms: ["computer use recent actions history log activity agent clicks"],
  },
  {
    id: "computer-use-getting-started",
    title: "Getting started",
    to: "/settings/integrations",
    searchTerms: [
      "computer use getting started setup guide how accessibility screen recording permission macos",
    ],
  },
  {
    id: "bitbucket-credentials",
    title: "Bitbucket credentials",
    to: "/settings/source-control",
    searchTerms: ["bitbucket atlassian access token api token email credentials sign in"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
