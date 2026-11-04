import * as Cause from "effect/Cause";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as { title: string } | null,
  dispatch: vi.fn(),
  navigate: vi.fn(),
  wait: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({ readThreadShell: () => state.shell }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.dispatch }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { v2: { dispatchCommand: {} } },
}));
vi.mock("./useCreateChildAgent", () => ({
  waitForThreadShell: (...args: unknown[]) => state.wait(...args),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => state.toast(...args) },
  stackedThreadToast: (value: unknown) => value,
}));

import { useForkThreadFromMessage } from "./ForkFromMessageButton";

let renderer: ReactTestRenderer | null = null;
let fork: ReturnType<typeof useForkThreadFromMessage>;
function Harness() {
  const action = useForkThreadFromMessage();
  useLayoutEffect(() => {
    fork = action;
  }, [action]);
  return null;
}
const source = scopeThreadRef(
  EnvironmentId.make("remote-environment"),
  ThreadId.make("imported-source"),
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.shell = { title: "Imported conversation" };
  state.dispatch.mockResolvedValue({ _tag: "Success", value: undefined });
  state.wait.mockResolvedValue(true);
  state.navigate.mockResolvedValue(undefined);
  act(() => {
    renderer = create(<Harness />);
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("exact user-message fork command", () => {
  it("forks a runless imported message by its exact id in the source environment", async () => {
    const id = MessageId.make("old-user-message");
    await act(async () => {
      await fork(source, id);
    });
    expect(state.dispatch).toHaveBeenCalledOnce();
    const command = state.dispatch.mock.calls[0]![0];
    expect(command).toMatchObject({
      environmentId: source.environmentId,
      input: {
        type: "thread.fork",
        sourceThreadId: source.threadId,
        sourceMessageId: id,
        sourcePoint: { type: "latest_stable" },
      },
    });
    const target: ScopedThreadRef = state.wait.mock.calls[0]![0];
    expect(target).toEqual(scopeThreadRef(source.environmentId, command.input.targetThreadId));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: source.environmentId,
        threadId: command.input.targetThreadId,
      },
    });
  });
  it("does not create or navigate when the source disappeared", async () => {
    state.shell = null;
    await fork(source, MessageId.make("message"));
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("leaves the source open when the destination command is rejected", async () => {
    state.dispatch.mockResolvedValue({ _tag: "Failure", cause: Cause.interrupt() });
    await fork(source, MessageId.make("message"));
    expect(state.wait).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
