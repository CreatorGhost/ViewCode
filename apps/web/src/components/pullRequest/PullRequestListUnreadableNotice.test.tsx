import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PullRequestListEmptyState } from "./PullRequestListEmptyState";
import { PullRequestListUnreadableNotice } from "./PullRequestListUnreadableNotice";
let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("exposes each unreadable repository reason on demand and can collapse it again", () => {
  act(() => {
    renderer = create(
      <PullRequestListUnreadableNotice
        unavailableProjects={
          new Map([
            ["Work", "Work account cannot access this repository"],
            ["Personal", "Personal account expired"],
          ])
        }
      />,
    );
  });
  expect(renderer.root.findAllByType("li")).toHaveLength(0);
  act(() => renderer.root.findByType("button").props.onClick());
  expect(renderer.root.findAllByType("li").map((node) => node.children.join(""))).toEqual([
    "Work — Work account cannot access this repository",
    "Personal — Personal account expired",
  ]);
  act(() => renderer.root.findByType("button").props.onClick());
  expect(renderer.root.findAllByType("li")).toHaveLength(0);
});

it("shows a repository read failure instead of claiming that a failed search had no matches", () => {
  act(() => {
    renderer = create(
      <PullRequestListEmptyState
        query="author:me"
        filtered
        searching={false}
        hasProjects
        canLoadMore={false}
        loadingMore={false}
        refreshing={false}
        unavailableProjects={new Map([["Work", "Work account cannot access this repository"]])}
        onClearQuery={() => {}}
        onLoadMore={() => {}}
        onRefresh={() => {}}
      />,
    );
  });
  expect(
    renderer.root
      .findAllByType("li")
      .some((node) => node.children.includes("Work account cannot access this repository")),
  ).toBe(true);
  expect(renderer.toJSON()).not.toBeNull();
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Nothing matches");
});
