import { ClerkFailed, ClerkLoading, useAuth, useClerk } from "@clerk/react";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { GlobeIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { usePrimarySessionState } from "~/environments/primary";
import { isElectron } from "~/env";
import { authEnvironment } from "~/state/auth";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  resolveAnywhereView,
  TUNNEL_BLOCKED_MESSAGE,
  TUNNEL_UNSTABLE_MESSAGE,
} from "./connectPhone.logic";

interface Props {
  readonly authContainerRef: RefObject<HTMLDivElement | null>;
  readonly isLoading: boolean;
  readonly needsNetworkAccess: boolean;
  readonly isRestarting: boolean;
  readonly onEnableNetworkAccess: () => void;
  /** The pairing QR for the tunnel's address; shown only while the tunnel is connected. */
  readonly renderQr: (baseUrl: string, host: string) => ReactNode;
}

/**
 * Keeps Clerk hooks out of builds where cloud identity is not configured. The
 * dialog does not offer this tab then, so there is no "not configured" state here.
 */
export function T3ConnectPhone(props: Props) {
  return hasCloudPublicConfig() ? <ConfiguredT3ConnectPhone {...props} /> : null;
}

function ConfiguredT3ConnectPhone({
  authContainerRef,
  isLoading,
  needsNetworkAccess,
  isRestarting,
  onEnableNetworkAccess,
  renderQr,
}: Props) {
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const {
    isSignedIn,
    linkState,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    reconcileCloudState,
    retryTunnel,
  } = useCloudLinkController();
  // The host pushes the tunnel's state on the access stream; nothing polls.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const access = useEnvironmentQuery(
    managedTunnelActive && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null })
      : null,
  );
  const view = resolveAnywhereView({
    managedTunnelActive,
    tunnel: access.data?.type === "snapshot" ? (access.data.payload.managedTunnel ?? null) : null,
  });
  const [isRetrying, setIsRetrying] = useState(false);
  const session = usePrimarySessionState();
  const canManage =
    session.data?.authenticated === true &&
    session.data.scopes?.includes(AuthRelayWriteScope) === true;
  const [isUpdating, setIsUpdating] = useState(false);
  const updatingRef = useRef(false);
  const enableAfterSignIn = useRef(false);
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);
  useEffect(
    () => () => {
      if (enableAfterSignIn.current) clerk.closeSignIn();
    },
    [clerk],
  );
  const busy = isLoading || isUpdating || isRestarting || linkState.isPending || !isLoaded;
  const error = operationError ?? linkState.error;

  const updateConnection = async (enabled: boolean) => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    setIsUpdating(true);
    try {
      await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    } finally {
      updatingRef.current = false;
      setIsUpdating(false);
    }
  };

  // A sign-in only enables access when it follows this dialog's explicit request.
  // Leaving the dialog discards the intent, so a later sign-in cannot expose a host.
  const finishSignIn = useEffectEvent(() => {
    if (!enableAfterSignIn.current) return;
    enableAfterSignIn.current = false;
    setWaitingForSignIn(false);
    if (!managedTunnelActive) void updateConnection(true);
  });
  const canFinishSignIn =
    isSignedIn && !busy && canManage && Boolean(linkState.target) && !needsNetworkAccess;
  useEffect(() => {
    if (canFinishSignIn) finishSignIn();
  }, [canFinishSignIn]);

  const enable = () => {
    if (!isSignedIn) {
      enableAfterSignIn.current = true;
      setWaitingForSignIn(true);
      // The desktop already uses hash routing for conversations. Clerk's modal
      // owns its routes, and this container keeps it inside the dialog's focus scope.
      clerk.openSignIn({
        ...resolveClerkSignInProps(window.location.href, isElectron),
        getContainer: () => authContainerRef.current,
        appearance: {
          elements: {
            // This modal is contained by our transformed dialog, not the viewport.
            // Clerk's fixed, viewport-sized backdrop otherwise clips the form.
            modalBackdrop: {
              position: "absolute",
              inset: "0",
              width: "100%",
              height: "100%",
              padding: "16px",
              background: "var(--card)",
              backdropFilter: "none",
              borderRadius: "inherit",
              overflowY: "auto",
            },
            modalContent: {
              position: "relative",
              inset: "auto",
              transform: "none",
              margin: "auto",
              width: "100%",
              maxWidth: "400px",
            },
          },
        },
      });
      return;
    }
    void updateConnection(true);
  };

  const tryAgain = async () => {
    setIsRetrying(true);
    try {
      await retryTunnel();
    } finally {
      setIsRetrying(false);
    }
  };

  const stopButton = (
    <Button variant="outline" disabled={busy} onClick={() => void updateConnection(false)}>
      {isUpdating ? <Spinner size="sm" /> : null}
      {isUpdating ? "Updating connection…" : "Turn off T3 Connect"}
    </Button>
  );

  return (
    <>
      {view.kind === "off" ? (
        <div className="flex items-start gap-3">
          <GlobeIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Connect from anywhere</p>
            <p className="text-sm text-muted-foreground">
              Use your phone on mobile data or another Wi-Fi network. ViewCode sets up the
              connection and shows a code to scan. Nothing to sign in to on your phone.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <ClerkLoading>
        <p role="status" className="text-sm text-muted-foreground">
          Loading T3 Connect sign-in…
        </p>
      </ClerkLoading>
      <ClerkFailed>
        <Alert variant="error">
          <AlertDescription>
            T3 Connect sign-in could not load. Check your internet connection and reopen ViewCode.
            If you are using a local browser address, try the desktop app. Same Wi-Fi is still
            available.
          </AlertDescription>
        </Alert>
      </ClerkFailed>

      {!linkState.target ? (
        <p className="text-sm text-muted-foreground">
          Open this dialog on the computer running ViewCode to enable T3 Connect.
        </p>
      ) : !canManage ? (
        <p className="text-sm text-muted-foreground">
          This connection does not have permission to manage T3 Connect. Use the desktop app on the
          host computer.
        </p>
      ) : needsNetworkAccess && !managedTunnelActive ? (
        <>
          <p className="text-sm text-muted-foreground">
            First enable network access. ViewCode will restart and return here. Wait for active work
            to finish before restarting.
          </p>
          <Button disabled={busy} onClick={onEnableNetworkAccess}>
            {isRestarting ? <Spinner size="sm" /> : null}
            Enable network access and restart
          </Button>
        </>
      ) : view.kind === "off" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={enable}>
            {isUpdating ? <Spinner size="sm" /> : null}
            {isUpdating
              ? "Turning on…"
              : isSignedIn
                ? "Turn on T3 Connect"
                : "Sign in and turn on T3 Connect"}
          </Button>
          {waitingForSignIn && !isSignedIn ? (
            <Button
              variant="ghost"
              onClick={() => {
                enableAfterSignIn.current = false;
                setWaitingForSignIn(false);
                clerk.closeSignIn();
              }}
            >
              Cancel setup
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {view.kind === "connecting" || view.kind === "unstable-reconnecting" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {view.kind === "connecting" ? "Connecting to T3 Connect…" : "Reconnecting…"}
            </p>
          ) : null}
          {view.kind === "unstable-reconnecting" ? (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertDescription>{TUNNEL_UNSTABLE_MESSAGE}</AlertDescription>
            </Alert>
          ) : null}
          {view.kind === "blocked" ? (
            <>
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>{TUNNEL_BLOCKED_MESSAGE}</AlertDescription>
              </Alert>
              <Button disabled={busy || isRetrying} onClick={() => void tryAgain()}>
                {isRetrying ? <Spinner size="sm" /> : null}
                Try again
              </Button>
            </>
          ) : null}
          {view.kind === "needs-relink" ? (
            <p className="text-sm text-muted-foreground">
              T3 Connect was set up before phone codes were available. Turn it off, then on again.
            </p>
          ) : null}
          {view.kind === "ready" ? (
            <>
              {view.unstable ? (
                <Alert variant="warning">
                  <TriangleAlertIcon />
                  <AlertDescription>{TUNNEL_UNSTABLE_MESSAGE}</AlertDescription>
                </Alert>
              ) : null}
              {renderQr(view.baseUrl, view.host)}
            </>
          ) : null}
          <div>{stopButton}</div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Keep this computer awake, online and ViewCode running. Turning off T3 Connect leaves same
        Wi-Fi pairing unchanged.
      </p>
    </>
  );
}
