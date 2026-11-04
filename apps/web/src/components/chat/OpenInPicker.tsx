import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
  useRemoteOpenTargetsLookup,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { describeTailscaleBlock, useTailscaleBlock } from "../../state/tailscaleAccess";
import { ChevronDownIcon, FolderClosedIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuShortcut,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  additionalMenuItems,
  menuLabel,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  additionalMenuItems?: (closeMenu: () => void) => ReactNode;
  menuLabel?: string;
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied = remote.mode === "local-exec" && !canOperateHost;
  const canOpenEditor = remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const [menuOpen, setMenuOpen] = useComposerMenuState(
    isHostEditorDenied && additionalMenuItems === undefined,
  );
  const sshRouteLookup = useRemoteOpenTargetsLookup(environmentId);
  const tailscaleBlock = useTailscaleBlock(environmentId);
  // Looking for an SSH route can run `tailscale` on the server, so it happens
  // only when the user opens this menu, never when the page loads.
  const onEditorMenuOpenChange = (open: boolean) => {
    if (open && remote.mode === "remote-unavailable") sshRouteLookup.lookUp();
  };
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  // Remote mode ignores the server's PATH probe: what matters is what runs on
  // the viewing machine, which only the desktop app can probe.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);

  const openInEditor = (editorId: EditorId | null) => {
    if (!openInCwd) return;
    const editor = editorId ?? preferredEditor;
    if (!editor) return;
    if (remote.mode === "remote-unavailable") return;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        host: remote.host.host,
        absolutePath: openInCwd,
      });
      if (url === undefined) return;
      // Only record hint-seen/preferred when the shell actually accepted
      // the URL (an older desktop build can refuse the editor scheme).
      void openRemoteEditorUrl(url).then((opened) => {
        if (!opened) return;
        markRemoteHintSeen();
        setPreferredEditor(editor);
      });
      return;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = openInEditorMutation({
      environmentId,
      input: {
        cwd: openInCwd,
        editor,
      },
    });
    setPreferredEditor(editor);
    return result;
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  useEffect(() => {
    if (!enableShortcut || !canOpenEditor) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;
      if (
        remote.mode === "local-exec" &&
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        return;

      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    canOpenEditor,
    enableShortcut,
    environmentId,
    keybindings,
    openInCwd,
    openInEditor,
    preferredEditor,
    remote.mode,
  ]);
  // Derived after the shortcut effect so the compiler can cache the resolved editor list.
  const options = resolveOpenInOptions(navigator.platform, effectiveEditors);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const primaryLabel = isPanel ? `Open in ${primaryOption?.label ?? "editor"}` : "Open";

  const editorItems = (
    <>
      {remote.mode === "remote-unavailable" ? (
        <>
          <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
            {sshRouteLookup.looking
              ? `Looking for an SSH route to ${environmentLabel}…`
              : `No SSH route to ${environmentLabel}`}
          </MenuItem>
          {tailscaleBlock !== null && !sshRouteLookup.looking ? (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              {describeTailscaleBlock(tailscaleBlock)}
            </MenuItem>
          ) : null}
        </>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              No installed editors found
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={!openInCwd || !canOpenEditor}
              key={value}
              onClick={() => {
                if (presentation === "menu") {
                  void openInEditor(value);
                } else {
                  setPreferredEditor(value);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={!openInCwd || !canOpenEditor}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>Open in {primaryOption.label}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub onOpenChange={onEditorMenuOpenChange}>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : compact
          ? { chip: true, className: "gap-1.5" }
          : {})}
    >
      <ThreadDetailsControl
        aria-label={compact ? "Open file in preferred editor" : primaryLabel}
        size={isPanel ? "sm" : compact ? "icon-header" : "xs"}
        variant={isPanel ? "ghost" : compact ? "header" : "outline"}
        part="primary"
        panel={isPanel}
        disabled={!preferredEditor || !openInCwd || !canOpenEditor}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon ? (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn(
              isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : compact ? undefined : "size-3.5",
              compact ? "text-foreground opacity-100" : getOpenInIconClass(primaryOption.kind),
            )}
          />
        ) : isPanel || compact ? (
          <SquareArrowOutUpRightIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : compact ? undefined : "size-3.5"}
          />
        ) : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
          )}
        >
          {primaryLabel}
        </span>
      </ThreadDetailsControl>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : compact ? null : (
        <GroupSeparator className="hidden @3xl/header-actions:block" />
      )}
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          onEditorMenuOpenChange(open);
        }}
      >
        <MenuTrigger
          disabled={isHostEditorDenied && additionalMenuItems === undefined}
          render={
            <ThreadDetailsControl
              aria-label={menuLabel ?? "Choose editor"}
              size={isPanel ? "sm" : compact ? "icon-header" : "icon-xs"}
              variant={isPanel ? "ghost" : compact ? "header" : "outline"}
              part="secondary"
              panel={isPanel}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={
              isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : compact ? undefined : "size-4"
            }
          />
        </MenuTrigger>
        <MenuPopup
          align="end"
          keepMounted={additionalMenuItems !== undefined}
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
          {additionalMenuItems ? (
            <>
              <MenuSeparator />
              {additionalMenuItems(() => setMenuOpen(false))}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
