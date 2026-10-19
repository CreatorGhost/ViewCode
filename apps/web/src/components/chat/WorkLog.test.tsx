// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkLogRow } from "./WorkLog";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(live: boolean, label: string) {
  act(() => {
    root.render(<WorkLogRow live={live} label={label} />);
  });
}

const row = () => host.querySelector("[data-work-row-arrive]");
const settledLabel = () => host.querySelector("[data-work-label-settle]");

describe("WorkLogRow live motion", () => {
  it("softens in a step that arrives while the agent works", () => {
    render(true, "Reading handoff.ts");
    expect(row()).not.toBeNull();
    expect(settledLabel()).toBeNull();
  });

  it("keeps history still when it mounts already finished", () => {
    render(false, "Read handoff.ts");
    expect(row()).toBeNull();
    expect(settledLabel()).toBeNull();
  });

  it("settles the label once when the step finishes", () => {
    render(true, "Reading handoff.ts");
    render(false, "Read handoff.ts");
    expect(settledLabel()?.textContent).toBe("Read handoff.ts");
    render(false, "Read handoff.ts");
    expect(host.querySelectorAll("[data-work-label-settle]")).toHaveLength(1);
  });
});
