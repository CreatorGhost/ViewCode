import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useProviderSelectionViews } from "./ProviderChoiceStep";

type ToastId = ReturnType<typeof toastManager.add>;

/**
 * App-level prompt for an environment still waiting on its first agent choice
 * outside onboarding (for example, onboarding finished on another client).
 * Hidden on the welcome wizard and on Settings > Providers, where the choice
 * itself is shown. Closing it hides it for this session.
 */
export function ProviderChoicePendingNotice() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const selectionViews = useProviderSelectionViews(environmentIds);
  const [dismissed, setDismissed] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const suppressed = pathname === "/welcome" || pathname.startsWith("/settings/providers");
  const target = suppressed
    ? undefined
    : environments.find(
        (environment, index) =>
          selectionViews[index] === "pending" && !dismissed.has(environment.environmentId),
      );
  const targetId = target?.environmentId;
  const targetLabel = target?.label;
  const activeRef = useRef<{ readonly toastId: ToastId; readonly key: string } | null>(null);

  useEffect(() => {
    const key = targetId === undefined ? null : `${targetId}\u0000${targetLabel ?? ""}`;
    const active = activeRef.current;
    if (active?.key === key) return;
    if (active !== null) {
      toastManager.close(active.toastId);
      activeRef.current = null;
    }
    if (targetId === undefined || key === null) return;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Choose which agents ViewCode may run on ${targetLabel ?? "this computer"}.`,
        timeout: 0,
        actionProps: {
          children: "Choose agents",
          onClick: () => {
            void navigate({ to: "/settings/providers", search: { environmentId: targetId } });
          },
        },
        data: {
          hideCopyButton: true,
          onClose: () => {
            activeRef.current = null;
            setDismissed((current) => new Set(current).add(targetId));
          },
        },
      }),
    );
    activeRef.current = { toastId, key };
  }, [navigate, targetId, targetLabel]);

  useEffect(
    () => () => {
      if (activeRef.current !== null) toastManager.close(activeRef.current.toastId);
      activeRef.current = null;
    },
    [],
  );

  return null;
}
