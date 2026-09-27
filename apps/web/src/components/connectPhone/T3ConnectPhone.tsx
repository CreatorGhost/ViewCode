import { ClerkFailed, ClerkLoading, useAuth, useClerk } from "@clerk/react";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { usePrimarySessionState } from "~/environments/primary";
import { isElectron } from "~/env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

interface Props {
  readonly authContainerRef: RefObject<HTMLDivElement | null>;
  readonly isLoading: boolean;
  readonly needsNetworkAccess: boolean;
  readonly isRestarting: boolean;
  readonly onEnableNetworkAccess: () => void;
}

/** Keeps Clerk hooks out of builds where cloud identity is not configured. */
export function T3ConnectPhone(props: Props) {
  if (!hasCloudPublicConfig()) {
    return (
      <Alert>
        <AlertDescription>
          T3 Connect is not configured in this build. Install a build with T3 Connect enabled to
          connect from anywhere. Local network pairing is still available.
        </AlertDescription>
      </Alert>
    );
  }
  return <ConfiguredT3ConnectPhone {...props} />;
}

function ConfiguredT3ConnectPhone({
  authContainerRef,
  isLoading,
  needsNetworkAccess,
  isRestarting,
  onEnableNetworkAccess,
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
  } = useCloudLinkController();
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

  return (
    <>
      <div className="flex items-start gap-3">
        <GlobeIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {managedTunnelActive ? "T3 Connect is turned on" : "Connect from anywhere"}
          </p>
          <p className="text-sm text-muted-foreground">
            Use your phone on mobile data or another Wi-Fi network. ViewCode sets up and runs the
            connection for you. No terminal commands or Tailscale needed.
          </p>
        </div>
      </div>

      {managedTunnelActive ? (
        <ol className="list-inside list-decimal space-y-2 text-sm">
          <li>Open the T3 Code app on your phone.</li>
          <li>Sign in to the same T3 Connect account used here.</li>
          <li>Select {linkState.target?.label ?? "this computer"} from your environments.</li>
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sign in once. ViewCode links this computer to your account and installs its connection
          helper if needed. Then sign in to the same account on your phone.
        </p>
      )}

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
            If you are using a local browser address, try the desktop app. Local pairing is still
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
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={managedTunnelActive ? "outline" : "default"}
            disabled={busy || (managedTunnelActive && !isSignedIn)}
            onClick={() => (managedTunnelActive ? void updateConnection(false) : enable())}
          >
            {isUpdating ? <Spinner size="sm" /> : null}
            {isUpdating
              ? "Updating connection…"
              : managedTunnelActive
                ? "Turn off T3 Connect"
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
      )}
      <p className="text-xs text-muted-foreground">
        Keep this computer awake, online and ViewCode running. Turning off T3 Connect leaves local
        network pairing unchanged.
      </p>
    </>
  );
}
