import { EnvironmentId, type SourceControlProviderAuth } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { reviewStyleKey } from "@t3tools/shared/reviewFindings";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_: unknown, select: (settings: UnifiedSettings) => unknown) =>
    select({
      ...DEFAULT_UNIFIED_SETTINGS,
      pullRequestReviewStyles: {
        [reviewStyleKey("github.com", "personal")]: "Personal style",
        [reviewStyleKey("github.com", "work")]: "Work style",
      },
    }),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.save }));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
import { ViewCodeReviewStyleAccounts } from "./ViewCodeReviewStyleAccounts";
const environmentId = EnvironmentId.make("style-environment");
const auth: SourceControlProviderAuth = {
  status: "authenticated",
  account: Option.some("personal"),
  host: Option.some("github.com"),
  detail: Option.none(),
  accounts: [
    { host: "github.com", account: "personal", active: true, authenticated: true },
    { host: "github.com", account: "work", active: false, authenticated: true },
  ],
};
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.save.mockReset().mockResolvedValue(AsyncResult.success({}));
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("isolates unsaved drafts between accounts and saves only the selected host/account style", async () => {
  act(() => {
    renderer = create(<ViewCodeReviewStyleAccounts environmentId={environmentId} auth={auth} />);
  });
  const input = () => renderer.root.findByType("textarea");
  expect(input().props.value).toBe("Personal style");
  act(() =>
    input().props.onChange({
      target: { value: "Unsaved personal draft" },
      currentTarget: { value: "Unsaved personal draft" },
      nativeEvent: {},
    }),
  );
  act(() => renderer.root.findByType("select").props.onChange({ target: { value: "work" } }));
  expect(input().props.value).toBe("Work style");
  act(() =>
    input().props.onChange({
      target: { value: "New work style" },
      currentTarget: { value: "New work style" },
      nativeEvent: {},
    }),
  );
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(commands.save).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      patch: {
        pullRequestReviewStyles: { [reviewStyleKey("github.com", "work")]: "New work style" },
      },
    },
  });
  act(() => renderer.root.findByType("select").props.onChange({ target: { value: "personal" } }));
  expect(input().props.value).toBe("Personal style");
});
