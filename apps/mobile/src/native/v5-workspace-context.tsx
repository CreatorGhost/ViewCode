import { createContext, type ReactNode } from "react";

// The router is shared with the other platforms; only iOS uses native columns.
// ViewCode has no v5 column navigator, so nothing provides these and they keep their defaults;
// they exist so upstream screens that read them need no fork-specific edits.
export const NativeWorkspaceModeContext = createContext(false);
/** Retained tabs must not update another tab's navigation options. */
export const NativeWorkspaceTabActivityContext = createContext<{
  readonly active: boolean;
  readonly isActive: () => boolean;
} | null>(null);
export const NativePrimaryColumnContext = createContext<{
  readonly selectedThreadKey: string | null;
  readonly selectedPullRequestKey: string | null;
} | null>(null);
export const NativeWorkspaceInspectorContext = createContext<{
  readonly render: (() => ReactNode) | undefined;
  readonly visible: boolean;
}>({ render: undefined, visible: false });
