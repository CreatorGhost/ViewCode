import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/separator", () => ({ Separator: () => <hr /> }));
import { ViewCodePullRequestProjectGroup } from "./ViewCodePullRequestProjectGroup";

let renderer: ReactTestRenderer;
const group = {
  key: "local:work",
  label: "Work folder",
  entries: [{ viewerLogin: "work-account" }],
};
const other = {
  key: "local:personal",
  label: "Personal folder",
  entries: [{ viewerLogin: "personal-account" }],
};
const storage = new Map<string, string>();
function folder(value = group, showHeader = true, children: ReactNode = <p>PR rows</p>) {
  return (
    <ViewCodePullRequestProjectGroup group={value} showHeader={showHeader}>
      {children}
    </ViewCodePullRequestProjectGroup>
  );
}
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    }),
  );
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("hides and reopens rows independently, retaining collapsed folders after revisiting", () => {
  act(() => {
    renderer = create(
      <>
        {folder()}
        {folder(other, true, <p>Personal rows</p>)}
      </>,
    );
  });
  expect(renderer.root.findAllByType("p")).toHaveLength(2);
  act(() => renderer.root.findAllByType("button")[0]?.props.onClick());
  expect(renderer.root.findAllByType("p").map((node) => node.children.join(""))).toEqual([
    "Personal rows",
  ]);
  expect(renderer.root.findAllByType("button")[0]?.props["aria-expanded"]).toBe(false);
  act(() => renderer.unmount());
  act(() => {
    renderer = create(folder());
  });
  expect(renderer.root.findAllByType("p")).toHaveLength(0);
  act(() => renderer.root.findByType("button").props.onClick());
  expect(renderer.root.findAllByType("p")).toHaveLength(1);
});

it("keeps rows visible when narrowing to a single previously collapsed project", () => {
  storage.set("viewcode:pull-requests:collapsed-groups", JSON.stringify([group.key]));
  act(() => {
    renderer = create(folder(group, false));
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  expect(renderer.root.findAllByType("p")).toHaveLength(1);
  act(() => renderer.update(folder()));
  expect(renderer.root.findAllByType("p")).toHaveLength(0);
});
