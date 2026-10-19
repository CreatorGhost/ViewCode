import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentificationMode: () => "none" as const,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { composerAvailabilityDisabledReason } from "./composerAvailability";

let root: Root;
let container: HTMLDivElement;
const onSubmit = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSubmit.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const available = {
  projectSelectionRequired: false,
  noProviderAvailable: false,
  providerCatalogPending: false,
};
const cases = [
  {
    name: "providers disabled",
    gates: { ...available, noProviderAvailable: true },
    label: "Select an enabled provider to send a message",
  },
  {
    name: "project required",
    gates: { ...available, projectSelectionRequired: true },
    label: "Choose a project to send a message",
  },
  {
    name: "provider catalog loading",
    gates: { ...available, noProviderAvailable: true, providerCatalogPending: true },
    label: "Loading providers",
  },
];
const layoutCases = [true, false].flatMap((compact) =>
  cases.map((input) => ({ ...input, compact })),
);

async function render(input: {
  compact: boolean;
  gates: typeof available;
  disconnected?: boolean;
  pending?: boolean;
}) {
  await act(async () =>
    root.render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <ComposerPrimaryActions
          compact={input.compact}
          canOperateThread
          pendingAction={
            input.pending
              ? {
                  questionIndex: 0,
                  isLastQuestion: true,
                  canAdvance: true,
                  isResponding: false,
                  isComplete: true,
                }
              : null
          }
          isRunning={false}
          canInterrupt={false}
          showPlanFollowUpPrompt={false}
          promptHasText
          isSendBusy={false}
          sendDisabledReason={null}
          isConnecting={false}
          isEnvironmentUnavailable={input.disconnected ?? false}
          availabilityDisabledReason={composerAvailabilityDisabledReason(input.gates)}
          isPreparingWorktree={false}
          hasSendableContent
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
        />
      </form>,
    ),
  );
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

it.each(layoutCases)(
  "keeps sending blocked with a truthful connected status: $name (compact=$compact)",
  async ({ compact, gates, label }) => {
    const blocked = await render({ compact, gates });
    expect(blocked.disabled).toBe(true);
    expect(blocked.getAttribute("aria-label")).toBe(label);
    await act(async () => blocked.click());
    expect(onSubmit).not.toHaveBeenCalled();

    const ready = await render({ compact, gates: available });
    expect(ready.disabled).toBe(false);
    expect(ready.getAttribute("aria-label")).toBe("Submit message");
    await act(async () => ready.click());
    expect(onSubmit).toHaveBeenCalledOnce();
  },
);

it.each(layoutCases)(
  "preserves pending-answer gates: $name (compact=$compact)",
  async ({ compact, gates }) => {
    const blocked = await render({ compact, gates, pending: true });
    expect(blocked.disabled).toBe(true);
    await act(async () => blocked.click());
    expect(onSubmit).not.toHaveBeenCalled();

    const ready = await render({ compact, gates: available, pending: true });
    expect(ready.disabled).toBe(false);
    await act(async () => ready.click());
    expect(onSubmit).toHaveBeenCalledOnce();
  },
);

it("reports actual disconnection before provider/project requirements and blocks submission", async () => {
  const blocked = await render({
    compact: false,
    gates: { ...available, noProviderAvailable: true, projectSelectionRequired: true },
    disconnected: true,
  });
  expect(blocked.disabled).toBe(true);
  expect(blocked.getAttribute("aria-label")).toBe("Environment disconnected");
  await act(async () => blocked.click());
  expect(onSubmit).not.toHaveBeenCalled();
});
