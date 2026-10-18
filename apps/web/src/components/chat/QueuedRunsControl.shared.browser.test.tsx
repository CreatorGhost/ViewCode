import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const source = vi.hoisted(() => ({
  current: undefined as { projection: OrchestrationV2ThreadProjection } | undefined,
  listeners: new Set<() => void>(),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: (() =>
    useSyncExternalStore(
      (listener) => {
        source.listeners.add(listener);
        return () => source.listeners.delete(listener);
      },
      () => source.current,
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => undefined) as never,
}));
vi.mock(import("../../assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrls: (() => []) as never,
}));
import { QueuedRunsControl } from "./QueuedRunsControl";
const roots = new Set<Root>();
function projection() {
  return {
    thread: { id: "thread:shared", activeProviderThreadId: null },
    runs: [
      { id: "run:first", userMessageId: "message:first", status: "queued", ordinal: 1 },
      { id: "run:second", userMessageId: "message:second", status: "queued", ordinal: 2 },
    ],
    messages: [
      { id: "message:first", text: "First message", attachments: [] },
      { id: "message:second", text: "Second message", attachments: [] },
    ],
    providerThreads: [],
    providerSessions: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
}
async function publish(next: OrchestrationV2ThreadProjection) {
  await act(async () => {
    source.current = { projection: next };
    for (const listener of source.listeners) listener();
  });
}
async function client(optimistic = false) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.add(root);
  await act(async () =>
    root.render(
      <QueuedRunsControl
        environmentId={"environment:shared" as never}
        threadId={"thread:shared" as never}
        optimisticMessages={
          optimistic
            ? [
                {
                  id: "message:first" as never,
                  inputIntent: "queued_turn",
                  text: "First message",
                  attachments: [],
                },
              ]
            : []
        }
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    ),
  );
  return { root, element };
}
const rows = (element: HTMLElement) =>
  [...element.querySelectorAll("li")].map((row) => row.textContent);
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  source.listeners.clear();
  source.current = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("shared authoritative queue projection", () => {
  it("updates both clients after an edit, reorder, cancellation and promotion", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const initial = projection();
    await publish(initial);
    const first = await client(true);
    const second = await client();
    expect(rows(first.element)).toEqual(rows(second.element));
    expect(rows(first.element)).toHaveLength(2);
    expect(first.element.querySelector('[aria-label="Saving queued message"]')).toBeNull();
    const edited = {
      ...initial,
      runs: initial.runs.map((run) => ({ ...run, queuePosition: run.ordinal === 2 ? 0 : 1 })),
      messages: initial.messages.map((message) =>
        message.id === "message:second"
          ? { ...message, text: "Edited on another device" }
          : message,
      ),
    };
    await publish(edited);
    for (const view of [first, second]) {
      expect(rows(view.element)[0]).toContain("Edited on another device");
      expect(rows(view.element)[1]).toContain("First message");
    }
    const cancelled = {
      ...edited,
      runs: edited.runs.map((run) =>
        run.ordinal === 1 ? { ...run, status: "cancelled" as const } : run,
      ),
    };
    await publish(cancelled);
    for (const view of [first, second]) {
      expect(rows(view.element)).toHaveLength(1);
      expect(view.element.textContent).not.toContain("First message");
    }
    await publish({
      ...cancelled,
      runs: cancelled.runs.map((run) =>
        run.ordinal === 2 ? { ...run, status: "starting" as const } : run,
      ),
    });
    expect(first.element.childElementCount).toBe(0);
    expect(second.element.childElementCount).toBe(0);
  });
  it("reconstructs the queue after the originating client closes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await publish(projection());
    const original = await client(true);
    const expected = rows(original.element);
    await act(async () => original.root.unmount());
    roots.delete(original.root);
    original.element.remove();
    expect(source.listeners.size).toBe(0);
    const reopened = await client();
    expect(rows(reopened.element)).toEqual(expected);
    expect(rows(reopened.element)).toHaveLength(2);
  });
});
