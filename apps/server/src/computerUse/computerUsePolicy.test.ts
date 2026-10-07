import { describe, expect, it } from "vite-plus/test";

import {
  describeInputForApproval,
  isDenylistedApp,
  isDestructiveChord,
  isDestructiveTarget,
} from "./computerUsePolicy.ts";

describe("isDenylistedApp", () => {
  it("refuses a browser window showing ViewCode, but not pages that only mention it", () => {
    const browser = (app: string, title: string) => isDenylistedApp({ app, title });
    expect(browser("Google Chrome", "ViewCode (Alpha) - Google Chrome")).toBe(true);
    expect(browser("Safari", "ViewCode")).toBe(true);
    expect(browser("Arc", "T3 Code (Dev) \u2014 Work")).toBe(true);
    expect(browser("Google Chrome", "GitHub - CreatorGhost/ViewCode")).toBe(false);
    expect(browser("Visual Studio Code", "ViewCode \u2014 server.ts")).toBe(false);
  });

  it.each([
    // Matched by the `.app` bundle on the executable path, whatever the window's app name says.
    {
      app: "Electron",
      appIdentifier: "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
    },
    {
      app: "ViewCode Helper (Renderer)",
      appIdentifier:
        "/Applications/ViewCode.app/Contents/Frameworks/ViewCode Helper (Renderer).app/Contents/MacOS/ViewCode Helper (Renderer)",
    },
    { app: "1Password", appIdentifier: "/Applications/1Password.app/Contents/MacOS/1Password" },
    {
      app: "Settings",
      appIdentifier: "/System/Applications/System Settings.app/Contents/MacOS/System Settings",
    },
    {
      app: "Keychain",
      appIdentifier:
        "/System/Applications/Utilities/Keychain Access.app/Contents/MacOS/Keychain Access",
    },
    // The shipped launcher: "ViewCode (Alpha)" with an Electron executable.
    {
      app: "ViewCode (Alpha)",
      appIdentifier: "/Applications/ViewCode (Alpha).app/Contents/MacOS/Electron",
    },
    { app: "ViewCode (Dev)", appIdentifier: "/tmp/build/Electron.app/Contents/MacOS/Electron" },
    { app: "ViewCode (Nightly)" },
    { app: "T3 Code (Dev)" },
    // Linux executables, and names alone when no path is known.
    { app: "bitwarden", appIdentifier: "/opt/Bitwarden/bitwarden" },
    { app: "ViewCode" },
  ])("refuses $app", (window) => {
    expect(isDenylistedApp(window)).toBe(true);
  });

  it.each([
    { app: "Notes", appIdentifier: "/System/Applications/Notes.app/Contents/MacOS/Notes" },
    {
      app: "Bambu Studio",
      appIdentifier: "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
    },
    { app: "Safari" },
  ])("allows $app", (window) => {
    expect(isDenylistedApp(window)).toBe(false);
  });
});

describe("destructive heuristic", () => {
  it("does not treat a canvas formatting description as a format action", () => {
    expect(
      isDestructiveTarget({
        role: "group",
        label: "Format, move, and resize items within the Canvas",
      }),
    ).toBe(false);
    expect(isDestructiveTarget({ role: "group", label: "Delete all items" })).toBe(true);
    expect(isDestructiveTarget({ role: "group", label: "Format disk" })).toBe(true);
    expect(isDestructiveTarget({ role: "button", label: "Format disk" })).toBe(true);
    expect(isDestructiveTarget({ role: "menu item", label: "Format" })).toBe(true);
    expect(isDestructiveTarget({ role: "unknown", label: "Format disk" })).toBe(true);
  });

  it("flags committing labels and quit or close chords only", () => {
    expect(isDestructiveTarget({ role: "button", label: "Place order" })).toBe(true);
    expect(isDestructiveTarget({ role: "button", label: "Send" })).toBe(true);
    expect(isDestructiveTarget({ role: "button", label: "Sender details" })).toBe(false);
    expect(isDestructiveChord("cmd+q")).toBe(true);
    expect(isDestructiveChord("alt+f4")).toBe(true);
    expect(isDestructiveChord("cmd+backspace")).toBe(true);
    expect(isDestructiveChord("cmd+shift+z")).toBe(false);
    expect(isDestructiveChord("q")).toBe(false);
  });
});

describe("describeInputForApproval", () => {
  it("counts typed characters instead of showing them", () => {
    const detail = describeInputForApproval(
      { command: "type-focused", window: 1, text: "correct horse" },
      { app: "Terminal", windowTitle: "zsh" },
    );
    expect(detail).toBe(
      'Type 13 characters into the focused field in Terminal — "zsh"; brings the window to the front',
    );
  });

  it("clips long window titles and labels", () => {
    const detail = describeInputForApproval(
      { command: "press", ref: 1 },
      {
        app: "Notes",
        windowTitle: "t".repeat(300),
        element: { role: "button", label: "l".repeat(300) },
      },
    );
    expect(detail).toContain(`"${"l".repeat(79)}…"`);
    expect(detail).toContain(`"${"t".repeat(79)}…"`);
    expect(detail.length).toBeLessThan(220);
  });

  it("states both points of a drag", () => {
    expect(
      describeInputForApproval(
        { command: "drag", shot: 3, fromX: 1, fromY: 2, toX: 30, toY: 40 },
        { app: "Bambu Studio", windowTitle: "Plate 1", hit: null },
      ),
    ).toBe(
      'Drag from (1, 2) to (30, 40) in Bambu Studio — "Plate 1" (no labelled control there); brings the window to the front',
    );
  });
});
