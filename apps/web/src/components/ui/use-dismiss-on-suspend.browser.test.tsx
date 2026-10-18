import { Activity, act, createRef, useState, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "./dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { DismissPopupsOnSuspendContext } from "./use-dismiss-on-suspend";

type Kind = "menu" | "popover" | "dialog" | "tooltip";
type Actions = { close: () => void; unmount: () => void };
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Popup({
  kind,
  actionsRef,
  controlled,
  onChange,
}: {
  kind: Kind;
  actionsRef: RefObject<Actions | null>;
  controlled: boolean;
  onChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const props = {
    actionsRef,
    ...(controlled ? { open } : { defaultOpen: true }),
    onOpenChange: (value: boolean) => {
      onChange(value);
      if (controlled) setOpen(value);
    },
  };
  switch (kind) {
    case "menu":
      return (
        <Menu {...props}>
          <MenuTrigger>Open menu</MenuTrigger>
          <MenuPopup>
            <MenuItem>Menu content</MenuItem>
          </MenuPopup>
        </Menu>
      );
    case "popover":
      return (
        <Popover {...props}>
          <PopoverTrigger>Open popover</PopoverTrigger>
          <PopoverPopup>
            <button>Popover content</button>
          </PopoverPopup>
        </Popover>
      );
    case "dialog":
      return (
        <Dialog {...props}>
          <DialogTrigger>Open dialog</DialogTrigger>
          <DialogPopup>
            <DialogTitle>Dialog content</DialogTitle>
          </DialogPopup>
        </Dialog>
      );
    case "tooltip":
      return (
        <Tooltip {...props}>
          <TooltipTrigger>Open tooltip</TooltipTrigger>
          <TooltipPopup>Tooltip content</TooltipPopup>
        </Tooltip>
      );
  }
}

async function mount(kind: Kind, scoped: boolean, controlled = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  const actionsRef = createRef<Actions | null>();
  const changes = vi.fn<(open: boolean) => void>();
  const show = async (visible: boolean) => {
    await act(() =>
      root.render(
        <DismissPopupsOnSuspendContext value={scoped}>
          <Activity mode={visible ? "visible" : "hidden"}>
            <Popup kind={kind} actionsRef={actionsRef} controlled={controlled} onChange={changes} />
          </Activity>
        </DismissPopupsOnSuspendContext>,
      ),
    );
  };
  await show(true);
  const selector = `[data-slot="${kind}-popup"]`;
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  return { actionsRef, show, selector, changes, container };
}

describe("cached surface popup suspension", () => {
  it.each(["menu", "popover", "dialog", "tooltip"] as const)(
    "closes and immediately unmounts a %s portal on Activity suspension",
    async (kind) => {
      const view = await mount(kind, true);
      const popup = document.querySelector(view.selector)!;
      await view.show(false);
      expect(document.querySelector(view.selector)).toBeNull();
      expect(popup.isConnected).toBe(false);
      expect(view.changes).toHaveBeenCalledWith(false);
      await view.show(true);
      expect(document.querySelector(view.selector)).toBeNull();
      if (kind !== "tooltip") {
        await userEvent.click(view.container.querySelector("button")!);
        await vi.waitFor(() => expect(document.querySelector(view.selector)).not.toBeNull());
      }
    },
  );

  it("preserves controlled close notifications and caller-owned imperative actions", async () => {
    const view = await mount("popover", true, true);
    const actions = view.actionsRef.current;
    expect(actions?.close).toBeTypeOf("function");
    await view.show(false);
    expect(view.changes).toHaveBeenCalledExactlyOnceWith(false);
    await view.show(true);
    expect(document.querySelector(view.selector)).toBeNull();
    await userEvent.click(view.container.querySelector("button")!);
    await vi.waitFor(() => expect(document.querySelector(view.selector)).not.toBeNull());
    await act(() => view.actionsRef.current!.close());
    expect(view.changes).toHaveBeenLastCalledWith(false);
  });

  it("leaves ordinary popup Activity lifecycle and actions untouched outside the opt-in surface", async () => {
    const view = await mount("popover", false);
    await view.show(false);
    expect(view.changes).not.toHaveBeenCalled();
    await view.show(true);
    await vi.waitFor(() => expect(document.querySelector(view.selector)).not.toBeNull());
    await act(() => view.actionsRef.current!.close());
    expect(view.changes).toHaveBeenCalledExactlyOnceWith(false);
  });
});
