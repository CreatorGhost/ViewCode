import { EllipsisIcon, PanelsTopLeftIcon, ScaleIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { OpenInPicker } from "./OpenInPicker";

export interface HeaderEnvironmentActions {
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  envLocked: boolean;
  onEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
}

function EnvironmentMenu({ environment }: { environment: HeaderEnvironmentActions }) {
  const selected = environment.availableEnvironments.find(
    (option) => option.environmentId === environment.environmentId,
  );
  return (
    <MenuSub>
      <MenuSubTrigger
        disabled={
          environment.envLocked ||
          (environment.onEnvironmentChange === undefined &&
            environment.onAutoEnvironment === undefined)
        }
      >
        <EnvironmentMachineIcon kind={selected?.machine ?? "server"} />
        <MenuItemLabel>
          Run on {environment.autoEnvironmentLabel ?? selected?.label ?? "this host"}
        </MenuItemLabel>
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          value={environment.autoEnvironmentLabel ? "auto" : environment.environmentId}
          onValueChange={(value) => {
            if (environment.envLocked) return;
            if (value === "auto") {
              environment.onAutoEnvironment?.();
              return;
            }
            const option = environment.availableEnvironments.find(
              (entry) => entry.environmentId === value,
            );
            if (option) environment.onEnvironmentChange?.(option.environmentId);
          }}
        >
          {environment.onAutoEnvironment ? (
            <MenuRadioItem value="auto">
              <span className="inline-flex items-center gap-2">
                <ScaleIcon aria-hidden className="size-4" />
                {environment.autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </MenuRadioItem>
          ) : null}
          {environment.availableEnvironments.map((option) => (
            <MenuRadioItem
              key={option.environmentId}
              value={option.environmentId}
              disabled={environment.onEnvironmentChange === undefined}
            >
              <span className="inline-flex items-center gap-2">
                <EnvironmentMachineIcon kind={option.machine} className="size-4" />
                {option.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The editor keeps its compact dev affordance; project controls share its dropdown. */
export function ViewCodeHeaderProjectActions({
  projectCwd,
  scripts,
  git,
  openIn,
  environment,
  onOpenThreadDetails,
}: {
  projectCwd: string | null;
  scripts: Omit<
    ComponentProps<typeof ProjectScriptsControl>,
    "presentation" | "fileScripts" | "onRequestMenuClose"
  >;
  git: ComponentProps<typeof GitActionsControl>;
  openIn?: Pick<
    ComponentProps<typeof OpenInPicker>,
    "environmentId" | "keybindings" | "availableEditors" | "openInCwd"
  >;
  environment?: HeaderEnvironmentActions;
  onOpenThreadDetails?: () => void;
}) {
  const visible = useClientSettings((settings) => settings.headerActionsVisible);
  const fileScripts = useT3ProjectFileScripts(scripts.environmentId, visible ? projectCwd : null);
  const [open, setOpen] = useState(false);
  const showProjectShortcuts = visible && projectCwd !== null;
  const hasMenuItems =
    showProjectShortcuts || environment !== undefined || onOpenThreadDetails !== undefined;
  const menuItems = (closeMenu: () => void) => (
    <>
      {environment ? <EnvironmentMenu environment={environment} /> : null}
      {showProjectShortcuts ? (
        <>
          {environment ? <MenuSeparator /> : null}
          <ProjectScriptsControl
            {...scripts}
            presentation="menu"
            fileScripts={fileScripts}
            onRequestMenuClose={closeMenu}
          />
          {git.gitCwd !== null ? (
            <>
              <MenuSeparator />
              <GitActionsControl {...git} presentation="menu" />
            </>
          ) : null}
        </>
      ) : null}
      {onOpenThreadDetails ? (
        <>
          {environment || showProjectShortcuts ? <MenuSeparator /> : null}
          <MenuItem onClick={onOpenThreadDetails}>
            <PanelsTopLeftIcon />
            <MenuItemLabel>Thread details</MenuItemLabel>
          </MenuItem>
        </>
      ) : null}
    </>
  );
  if (openIn) {
    return (
      <OpenInPicker
        {...openIn}
        compact
        {...(hasMenuItems ? { additionalMenuItems: menuItems, menuLabel: "Project actions" } : {})}
      />
    );
  }
  if (!hasMenuItems) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={<Button variant="header" size="icon-header" aria-label="Project actions" />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" keepMounted>
        {menuItems(() => setOpen(false))}
      </MenuPopup>
    </Menu>
  );
}
