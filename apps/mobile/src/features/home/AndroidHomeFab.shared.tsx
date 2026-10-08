import type { ReactNode } from "react";

/** Other platforms render the list without Android's floating composer and button. */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  /** Starts a new thread with dictation; omitted where this device cannot dictate. */
  readonly onStartVoiceTask?: () => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}) {
  return <>{props.children}</>;
}
