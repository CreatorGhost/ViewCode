// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ cancel: vi.fn(), resume: vi.fn() }));
vi.mock("../../state/agentControl", () => ({
  agentControlEnvironment: { cancelUsageResume: "cancel", resumeUsageNow: "resume" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "cancel" | "resume") => commands[command],
}));

import { useThreadUsageResume } from "./useThreadUsageResume";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
let root: Root | null = null;
let container: HTMLDivElement;

function Harness({ target }: { target: ScopedThreadRef | null }) {
  const controls = useThreadUsageResume(target);
  const [error, setError] = useState("");
  if (target === null) return <p>Loading thread</p>;
  return (
    <>
      <button
        disabled={controls.busy}
        onClick={() => void controls.onResumeNow().catch((cause) => setError(String(cause)))}
      >
        Resume now
      </button>
      <output>{error}</output>
    </>
  );
}

function render(target: ScopedThreadRef | null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (root === null) {
    container = document.createElement("div");
    root = createRoot(container);
  }
  act(() => root!.render(<Harness target={target} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

it("keeps hook order through loading, ready, and loading again without dispatching", () => {
  render(null);
  expect(container.textContent).toBe("Loading thread");
  render(threadRef);
  expect(container.querySelector("button")?.disabled).toBe(false);
  render(null);
  expect(container.textContent).toBe("Loading thread");
  render(threadRef);
  expect(commands.resume).not.toHaveBeenCalled();
  expect(commands.cancel).not.toHaveBeenCalled();
});

it("targets the ready thread and clears busy state when the command fails", async () => {
  let reject!: (cause: Error) => void;
  commands.resume.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(null);
  render(threadRef);
  act(() => container.querySelector("button")!.click());
  expect(commands.resume).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => reject(new Error("denied")));
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(container.querySelector("output")?.textContent).toContain("denied");
});
