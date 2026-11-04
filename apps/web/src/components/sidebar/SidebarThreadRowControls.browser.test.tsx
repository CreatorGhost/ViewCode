import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { SidebarThreadRowControls } from "./SidebarThreadRowControls";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderRow(hasDraft: boolean, timeLabel = "1m") {
  const expand = vi.fn();
  const openPr = vi.fn();
  const archive = vi.fn();
  await act(async () => {
    root.render(
      <>
        <button type="button" data-outside>
          Outside row
        </button>
        <div className="group/sidebar-row flex w-80 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">Parent thread with thirteen children</span>
          <button
            type="button"
            aria-label="Expand child agents, 13 done"
            className="h-5 w-4 shrink-0"
            onClick={expand}
          >
            ›
          </button>
          <button type="button" className="h-5 w-10 shrink-0" onClick={openPr}>
            #165
          </button>
          <SidebarThreadRowControls
            resting={<span data-metadata>{timeLabel}</span>}
            actions={
              <>
                {hasDraft ? (
                  <button type="button" className="size-5 shrink-0" aria-label="Discard draft">
                    D
                  </button>
                ) : null}
                <button type="button" className="size-5 shrink-0" aria-label="Pin thread">
                  P
                </button>
                <button
                  type="button"
                  className="size-5 shrink-0"
                  aria-label="Archive thread"
                  onClick={archive}
                >
                  A
                </button>
              </>
            }
          />
        </div>
      </>,
    );
  });
  const outside = container.querySelector<HTMLButtonElement>("[data-outside]")!;
  const disclosure = container.querySelector<HTMLButtonElement>(
    '[aria-label="Expand child agents, 13 done"]',
  )!;
  await userEvent.hover(outside);
  return { outside, disclosure, expand, openPr, archive };
}

describe("sidebar thread hover controls", () => {
  it.each([
    { hasDraft: false, timeLabel: "1m" },
    { hasDraft: true, timeLabel: "1m" },
    { hasDraft: false, timeLabel: "Yesterday at 11:30" },
    { hasDraft: true, timeLabel: "Yesterday at 11:30" },
  ])(
    "keeps the child disclosure under the pointer when hover actions appear, draft=$hasDraft, time=$timeLabel",
    async ({ hasDraft, timeLabel }) => {
      const { outside, disclosure, expand, openPr } = await renderRow(hasDraft, timeLabel);
      const before = disclosure.getBoundingClientRect();
      const x = before.x + before.width / 2;
      const y = before.y + before.height / 2;
      await userEvent.hover(disclosure);
      const target = document.elementFromPoint(x, y);
      expect(target).toBe(disclosure);
      expect(disclosure.getBoundingClientRect().x).toBe(before.x);
      await userEvent.click(target!);
      expect(expand).toHaveBeenCalledOnce();
      expect(openPr).not.toHaveBeenCalled();
      const metadata = container.querySelector<HTMLElement>("[data-metadata]")!;
      expect(getComputedStyle(metadata).visibility).toBe("hidden");
      await userEvent.hover(outside);
      expect(getComputedStyle(metadata).visibility).toBe("visible");
      expect(disclosure.getBoundingClientRect().x).toBe(before.x);
    },
  );

  it("keeps hover actions keyboard reachable without moving the disclosure", async () => {
    const { outside, disclosure, archive, expand, openPr } = await renderRow(true);
    const before = disclosure.getBoundingClientRect();
    await userEvent.click(outside);
    await userEvent.tab();
    expect(document.activeElement).toBe(disclosure);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    const archiveButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Archive thread"]',
    )!;
    expect(document.activeElement).toBe(archiveButton);
    expect(getComputedStyle(archiveButton.parentElement!).opacity).toBe("1");
    expect(disclosure.getBoundingClientRect().x).toBe(before.x);
    await userEvent.keyboard("{Enter}");
    expect(archive).toHaveBeenCalledOnce();
    expect(expand).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
  });
});
