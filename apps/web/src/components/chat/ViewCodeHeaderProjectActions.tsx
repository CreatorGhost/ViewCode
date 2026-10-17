import { EllipsisIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

/** The optional project/Git shortcuts retain their old setting; review and agent controls do not. */
export function ViewCodeHeaderProjectActions({
  projectCwd,
  scripts,
  git,
}: {
  projectCwd: string | null;
  scripts: Omit<
    ComponentProps<typeof ProjectScriptsControl>,
    "presentation" | "fileScripts" | "onRequestMenuClose"
  >;
  git: ComponentProps<typeof GitActionsControl>;
}) {
  const visible = useClientSettings((settings) => settings.headerActionsVisible);
  const fileScripts = useT3ProjectFileScripts(scripts.environmentId, visible ? projectCwd : null);
  const [open, setOpen] = useState(false);
  if (!visible || projectCwd === null) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button variant="chip" size="icon-chip" aria-label="Project actions" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" keepMounted>
        <ProjectScriptsControl
          {...scripts}
          presentation="menu"
          fileScripts={fileScripts}
          onRequestMenuClose={() => setOpen(false)}
        />
        {git.gitCwd !== null ? (
          <>
            <MenuSeparator />
            <GitActionsControl {...git} presentation="menu" />
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
