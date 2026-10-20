import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const titles = vi.hoisted(() => new Map<string, string>());

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: ScopedThreadRef | null) => {
    const title = ref === null ? undefined : titles.get(ref.threadId);
    return title === undefined ? null : { id: ref!.threadId, projectId: "project-1", title };
  }) as never,
  useProject: (() => null) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const environmentId = EnvironmentId.make("environment-1");
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  titles.clear();
  vi.unstubAllGlobals();
});

async function renderInRouter(text: string) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ChatMarkdown cwd="/tmp/project" environmentId={environmentId} text={text} />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/environment-1/current"] }),
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RouterProvider router={router} />));
  return { container, router };
}

it("opens a linked thread in the app under its current title", async () => {
  titles.set("thread-1", "Fix the build");
  const { container, router } = await renderInRouter(
    "See [Old name](t3-thread://v1/thread-1) for details.",
  );

  const link = container.querySelector("a");
  expect(link?.textContent).toBe("Fix the build");
  expect(link?.getAttribute("target")).toBeNull();

  await act(async () => link?.click());
  expect(router.state.location.pathname).toBe("/environment-1/thread-1");
});

it("follows a percent-encoded id to the thread it names", async () => {
  titles.set("thread:project:1", "Delegated task");
  const { container, router } = await renderInRouter("[task](t3-thread://v1/thread%3Aproject%3A1)");

  const link = container.querySelector("a");
  expect(link?.textContent).toBe("Delegated task");
  await act(async () => link?.click());
  expect(router.state.location.pathname).toBe(
    `/environment-1/${encodeURIComponent(ThreadId.make("thread:project:1"))}`,
  );
});

it("keeps the written label for a thread this environment no longer has", async () => {
  const { container } = await renderInRouter("[Removed work](t3-thread://v1/gone)");

  const link = container.querySelector("a");
  expect(link?.textContent).toBe("Removed work");
  expect(link?.getAttribute("title")).toBe("Thread no longer available");
});
