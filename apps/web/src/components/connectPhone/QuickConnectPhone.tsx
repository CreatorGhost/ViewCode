import type { ViewCodeRelayState } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, GlobeIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { authEnvironment } from "~/state/auth";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Spinner } from "../ui/spinner";
import {
  QUICK_CONNECT_SETUP_COMMAND,
  QUICK_CONNECT_TRAFFIC_NOTE,
  resolveQuickConnectView,
} from "./connectPhone.logic";

/** The relay connection's state, pushed by the server on the access stream; null until it arrives. */
export function useViewCodeRelayState(): ViewCodeRelayState | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const access = useEnvironmentQuery(
    primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null })
      : null,
  );
  return access.data?.type === "snapshot" ? (access.data.payload.viewcodeRelay ?? null) : null;
}

/**
 * The Quick connect tab: this computer dials out to the person's own
 * Cloudflare relay, so a phone can reach it where tunnels are blocked. The
 * server pushes the connection's state on the access stream (no polling); the
 * switch is the `viewcodeRelay.enabled` server setting.
 */
export function QuickConnectPhone({
  renderQr,
}: {
  /** The pairing QR for the relay's address; shown only while the relay connection is up. */
  readonly renderQr: (baseUrl: string, host: string) => ReactNode;
}) {
  const relay = useViewCodeRelayState();
  const updateSettings = useUpdatePrimarySettings();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "setup command" });
  const view = resolveQuickConnectView(relay);
  const setEnabled = (enabled: boolean) => updateSettings({ viewcodeRelay: { enabled } });

  const turnOff = (
    <div>
      <Button variant="outline" onClick={() => setEnabled(false)}>
        Turn off Quick connect
      </Button>
    </div>
  );
  const setupCommand = (
    <InputGroup>
      <InputGroupInput
        size="sm"
        readOnly
        value={QUICK_CONNECT_SETUP_COMMAND}
        aria-label="Quick connect setup command"
        onFocus={(event) => event.currentTarget.select()}
      />
      <InputGroupAddon align="inline-end">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy setup command"
          onClick={() => copyToClipboard(QUICK_CONNECT_SETUP_COMMAND, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );

  return (
    <div className="space-y-3">
      {view.kind === "loading" ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : null}

      {view.kind === "not-set-up" ? (
        <>
          <div className="flex items-start gap-3">
            <GlobeIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Quick connect</p>
              <p className="text-sm text-muted-foreground">
                Reach this computer from your phone over the internet, including on networks that
                block tunnels. ViewCode connects out to a small relay that runs on your own
                Cloudflare account.
              </p>
            </div>
          </div>
          <p className="text-sm">Set it up once, from the ViewCode folder on this computer:</p>
          {setupCommand}
          <p className="text-xs text-muted-foreground">
            It signs you in to Cloudflare, deploys the relay and stores its address here. This page
            updates when it is done.
          </p>
        </>
      ) : null}

      {view.kind === "off" ? (
        <>
          <p className="text-sm">
            Quick connect is set up but turned off. Turn it on to show a code for your phone.
          </p>
          <div>
            <Button onClick={() => setEnabled(true)}>Turn on Quick connect</Button>
          </div>
        </>
      ) : null}

      {view.kind === "connecting" || view.kind === "reconnecting" ? (
        <>
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {view.kind === "connecting"
              ? "Connecting to your relay…"
              : "Reconnecting to your relay…"}
          </p>
          {view.kind === "reconnecting" && view.reason ? (
            <p className="text-xs text-muted-foreground">{view.reason}</p>
          ) : null}
          {turnOff}
        </>
      ) : null}

      {view.kind === "blocked" ? (
        <>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>
              {view.reason ??
                "This network's security certificate is not trusted by this computer."}{" "}
              ViewCode keeps trying and will connect as soon as the network allows it.
            </AlertDescription>
          </Alert>
          {turnOff}
        </>
      ) : null}

      {view.kind === "auth-failed" ? (
        <>
          <Alert variant="error">
            <AlertDescription>
              {view.reason ?? "The relay did not accept this computer's secret."} Run this again:
            </AlertDescription>
          </Alert>
          {setupCommand}
          {turnOff}
        </>
      ) : null}

      {view.kind === "ready" ? (
        <>
          {renderQr(view.baseUrl, view.host)}
          {turnOff}
        </>
      ) : null}

      {view.kind !== "loading" ? (
        <p className="text-xs text-muted-foreground">{QUICK_CONNECT_TRAFFIC_NOTE}</p>
      ) : null}
    </div>
  );
}
