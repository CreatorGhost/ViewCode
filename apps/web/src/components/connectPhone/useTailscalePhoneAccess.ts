import type { DesktopTailscalePhoneAccess } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/**
 * What the desktop found out about Tailscale: whether the CLI is on disk, and
 * the launch-time opt-in. Null outside the desktop app and until it answers.
 * The desktop looks at files only, so asking is free on a computer without it.
 */
export function useTailscalePhoneAccess() {
  const [access, setAccess] = useState<DesktopTailscalePhoneAccess | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.desktopBridge?.getTailscalePhoneAccess?.().then(
      (value) => {
        if (!cancelled) setAccess(value);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setAutomatic = async (automatic: boolean) => {
    const next = await window.desktopBridge?.setTailscalePhoneAccessAutomatic?.(automatic);
    if (next) setAccess(next);
  };
  return { access, setAutomatic };
}
