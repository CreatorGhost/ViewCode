import { describe, expect, it } from "vite-plus/test";
import {
  initialPullRequestSearchState,
  pullRequestSearchReducer,
} from "./pull-request-search-state";

describe("pull request list search", () => {
  it("cancel restores the unfiltered list position after searching and scrolling", () => {
    let state = initialPullRequestSearchState();
    state = pullRequestSearchReducer(state, { type: "scroll", offset: 640 });
    state = pullRequestSearchReducer(state, { type: "search" });
    state = pullRequestSearchReducer(state, { type: "query", query: "navigation" });
    state = pullRequestSearchReducer(state, { type: "scroll", offset: 160 });
    expect(pullRequestSearchReducer(state, { type: "cancel" })).toMatchObject({
      query: "",
      searching: false,
      scrollOffset: 640,
    });
  });

  it("clearing and refocusing search retain the position cancel restores", () => {
    let state = initialPullRequestSearchState();
    state = pullRequestSearchReducer(state, { type: "scroll", offset: 500 });
    state = pullRequestSearchReducer(state, { type: "search" });
    state = pullRequestSearchReducer(state, { type: "query", query: "diff" });
    state = pullRequestSearchReducer(state, { type: "scroll", offset: 80 });
    state = pullRequestSearchReducer(state, { type: "query", query: "" });
    state = pullRequestSearchReducer(state, { type: "search" });
    expect(state).toMatchObject({ query: "", searching: true, searchEntryOffset: 500 });
    expect(pullRequestSearchReducer(state, { type: "cancel" }).scrollOffset).toBe(500);
  });

  it("a new search captures the position reached after the previous search ended", () => {
    let state = pullRequestSearchReducer(initialPullRequestSearchState(), { type: "search" });
    state = pullRequestSearchReducer(state, { type: "cancel" });
    state = pullRequestSearchReducer(state, { type: "scroll", offset: 240 });
    state = pullRequestSearchReducer(state, { type: "search" });
    expect(pullRequestSearchReducer(state, { type: "cancel" }).scrollOffset).toBe(240);
  });
});
