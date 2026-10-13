import { FolderGit2Icon, FolderPlusIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";

/**
 * The title row's one creation menu: New chat, New folder (a new Git project from a name, on
 * servers that have a folder for those), and Add project (an existing folder or a clone).
 * The actions and shortcuts are the ones the header's separate buttons had.
 */
export const SidebarNewMenu = memo(function SidebarNewMenu(props: {
  /** Receives the click so Shift+click still skips the project picker. */
  onNewChat: (event: ReactMouseEvent) => void;
  newChatDisabled: boolean;
  newChatShortcutLabel: string | null | undefined;
  /** Null when no connected server can create a project from a name. */
  onNewFolder: (() => void) | null;
  onAddProject: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="outline" size="xs" aria-label="New chat, folder or project" />}
      >
        <PlusIcon />
        New
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={props.newChatDisabled} onClick={props.onNewChat}>
          <SquarePenIcon />
          New chat
          {props.newChatShortcutLabel ? (
            <MenuShortcut>{props.newChatShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
        {props.onNewFolder ? (
          <MenuItem onClick={props.onNewFolder}>
            <FolderGit2Icon />
            New folder
          </MenuItem>
        ) : null}
        <MenuItem onClick={props.onAddProject}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
