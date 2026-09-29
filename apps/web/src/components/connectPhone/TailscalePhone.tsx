import { TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { useEnvironmentQuery } from "~/state/query";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { type PhoneEndpoint, resolveTailscaleView } from "./connectPhone.logic";

/**
 * The Tailscale tab. One button turns on Tailscale Serve (the same switch as
 * Settings → Connections) and the app restarts once; the QR then uses the
 * machine's tailnet HTTPS address. Only offered where the desktop found the CLI.
 */
export function TailscalePhone({
  renderQr,
  onBeforeRestart,
}: {
  readonly renderQr: (endpoint: PhoneEndpoint) => ReactNode;
  /** Called just before the restart, to leave a note for the relaunched app. */
  readonly onBeforeRestart: () => void;
}) {
  const network = useEnvironmentQuery(desktopNetworkAccessStateAtom).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!network) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  const view = resolveTailscaleView({
    serveEnabled: network.serverExposureState.tailscaleServeEnabled,
    endpoints: network.advertisedEndpoints,
  });
  if (view.kind === "ready") return renderQr(view.endpoint);

  const turnOn = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setPending(true);
    setError(null);
    onBeforeRestart();
    try {
      await bridge.setTailscaleServeEnabled({ enabled: true });
      refreshDesktopNetworkAccessState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not turn on Tailscale.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      {view.kind === "unavailable" ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>
            Tailscale is on in ViewCode but gave no address. Open Tailscale, sign in and connect,
            then try again.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm">
          Reach this computer from your phone over your tailnet. ViewCode turns on Tailscale HTTPS
          and restarts once, then shows a code to scan.
        </p>
      )}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "unavailable" ? (
        <Button variant="outline" onClick={refreshDesktopNetworkAccessState}>
          Try again
        </Button>
      ) : (
        <Button disabled={pending} onClick={() => void turnOn()}>
          {pending ? <Spinner size="sm" /> : null}
          Turn on Tailscale
        </Button>
      )}
    </div>
  );
}
