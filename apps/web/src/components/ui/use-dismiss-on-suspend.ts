import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from "react";

export const DismissPopupsOnSuspendContext = createContext(false);
type PopupActions = { close: () => void; unmount: () => void };

export function useDismissOnSuspend<Actions extends PopupActions>(
  provided?: RefObject<Actions | null>,
) {
  const enabled = useContext(DismissPopupsOnSuspendContext);
  const local = useRef<Actions | null>(null);
  const actionsRef = provided ?? local;
  const suspended = useRef(false);
  useLayoutEffect(() => {
    if (!enabled) return;
    const actions = actionsRef.current;
    // Controlled state can settle only on reveal and recreate an already closed exit portal.
    if (suspended.current) {
      suspended.current = false;
      actions?.unmount();
    }
    // Activity leaves body portals outside its hidden DOM and disconnects their refs first.
    return () => {
      suspended.current = true;
      actions?.close();
      actions?.unmount();
    };
  }, [actionsRef, enabled]);
  return enabled ? actionsRef : provided;
}
