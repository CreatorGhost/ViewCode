import {
  AuthAccessWriteScope,
  type AuthPairingCredentialResult,
  type DesktopLanReachability,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon, CopyIcon, SmartphoneIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  createServerPairingCredential,
  isLoopbackHostname,
  revokeServerPairingLink,
  usePrimarySessionState,
} from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { resolveDesktopPairingUrl } from "../settings/pairingUrls";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { QuickConnectPhone } from "./QuickConnectPhone";
import { TailscalePhone } from "./TailscalePhone";
import {
  CONNECT_PHONE_CODE_TTL_SECONDS,
  CONNECT_PHONE_RESUME_KEY,
  type AnywhereMode,
  type ConnectMode,
  type ConnectPhoneState,
  ANYWHERE_MODES,
  describeLanReachability,
  formatPairingExpiry,
  isAnywhereMode,
  QUICK_CONNECT_STABLE_NOTE,
  type PhoneEndpoint,
  resolveConnectModes,
  resolveConnectPhoneState,
  resolvePairingCodeStatus,
  resolveSelectedMode,
  shouldResumeConnectPhone,
  canTestLanReachability,
} from "./connectPhone.logic";
import { useTailscalePhoneAccess } from "./useTailscalePhoneAccess";

const CONNECT_PHONE_MODE_KEY = "viewcode:connect-phone-mode";
const useConnectPhoneDialogStore = create<{
  open: boolean;
  mode: ConnectMode;
  /** The last method picked under Anywhere, restored when switching back from Same Wi-Fi. */
  anywhere: AnywhereMode;
}>(() => ({
  open: false,
  mode: "local",
  anywhere: "quick",
}));

function selectConnectMode(mode: ConnectMode): void {
  useConnectPhoneDialogStore.setState(isAnywhereMode(mode) ? { mode, anywhere: mode } : { mode });
}

/** Opens the Connect phone dialog from anywhere (sidebar, command palette, settings). */
export function openConnectPhoneDialog(mode?: ConnectMode): void {
  if (mode !== undefined) selectConnectMode(mode);
  useConnectPhoneDialogStore.setState({ open: true });
}

export function useConnectPhoneDialogOpen(): boolean {
  return useConnectPhoneDialogStore((state) => state.open);
}

function writeResumeFlag(): void {
  try {
    window.localStorage.setItem(CONNECT_PHONE_RESUME_KEY, String(Date.now()));
    window.localStorage.setItem(CONNECT_PHONE_MODE_KEY, useConnectPhoneDialogStore.getState().mode);
  } catch {
    // Without storage the relaunched app just doesn't reopen the dialog.
  }
}

function takeResumeFlag(): boolean {
  try {
    const stored = window.localStorage.getItem(CONNECT_PHONE_RESUME_KEY);
    if (stored === null) return false;
    window.localStorage.removeItem(CONNECT_PHONE_RESUME_KEY);
    const resume = shouldResumeConnectPhone(stored, Date.now());
    const storedMode = window.localStorage.getItem(CONNECT_PHONE_MODE_KEY);
    if (resume && storedMode === "tailscale") {
      selectConnectMode(storedMode);
    }
    window.localStorage.removeItem(CONNECT_PHONE_MODE_KEY);
    return resume;
  } catch {
    return false;
  }
}

function clearResumeFlag(): void {
  try {
    window.localStorage.removeItem(CONNECT_PHONE_RESUME_KEY);
    window.localStorage.removeItem(CONNECT_PHONE_MODE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Mounted once at the app root. Reopens the dialog after a "Turn on and restart" relaunch. */
export function ConnectPhoneDialogHost() {
  const open = useConnectPhoneDialogStore((state) => state.open);
  useEffect(() => {
    if (takeResumeFlag()) openConnectPhoneDialog();
  }, []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => useConnectPhoneDialogStore.setState({ open: next })}
    >
      {/* The popup mounts its content only while open, so nothing below runs when closed. */}
      <DialogPopup className="max-w-md">
        <ConnectPhoneDialogContent />
      </DialogPopup>
    </Dialog>
  );
}

const MODE_LABELS: Record<ConnectMode, string> = {
  local: "Same Wi-Fi",
  quick: "Quick connect",
  tailscale: "Tailscale",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function useConnectPhoneState(): ConnectPhoneState {
  const desktopBridge = window.desktopBridge;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const desktopNetwork = useEnvironmentQuery(
    desktopBridge && !localEnvironmentDisabled ? desktopNetworkAccessStateAtom : null,
  );
  const session = usePrimarySessionState();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (desktopBridge) {
    const snapshot = desktopNetwork.data;
    return resolveConnectPhoneState({
      desktop: {
        localEnvironmentDisabled,
        network: snapshot
          ? {
              exposureMode: snapshot.serverExposureState.mode,
              endpoints: snapshot.advertisedEndpoints,
            }
          : null,
      },
      web: null,
    });
  }
  const sessionData = session.data;
  const web =
    sessionData !== null
      ? {
          hasServer: sessionData.authenticated && primaryEnvironmentId !== null,
          canManageAccess: sessionData.authenticated
            ? (sessionData.scopes?.includes(AuthAccessWriteScope) ?? false)
            : false,
          origin: window.location.origin,
          originIsLoopback: isLoopbackHostname(window.location.hostname),
        }
      : session.error !== null
        ? { hasServer: false, canManageAccess: false, origin: "", originIsLoopback: false }
        : null;
  return resolveConnectPhoneState({ desktop: null, web });
}

function ConnectPhoneDialogContent() {
  const state = useConnectPhoneState();
  const tailscale = useTailscalePhoneAccess();
  const modes = resolveConnectModes({
    tailscaleInstalled: tailscale.access?.installed === true,
  });
  const mode = resolveSelectedMode(
    useConnectPhoneDialogStore((value) => value.mode),
    modes,
  );
  const anywhereModes = ANYWHERE_MODES.filter((value) => modes.includes(value));
  const rememberedAnywhere = useConnectPhoneDialogStore((value) => value.anywhere);
  const anywhereMode = anywhereModes.includes(rememberedAnywhere)
    ? rememberedAnywhere
    : (anywhereModes[0] ?? "quick");
  // The advertised address goes stale when Wi-Fi or a VPN changes, so each
  // open asks the desktop for a fresh snapshot instead of trusting the cache.
  useEffect(() => {
    if (window.desktopBridge) refreshDesktopNetworkAccessState();
  }, []);
  const [pendingMode, setPendingMode] = useState<"on" | "off" | null>(null);
  const [confirmingTurnOff, setConfirmingTurnOff] = useState(false);
  const [exposureError, setExposureError] = useState<string | null>(null);

  const setNetworkAccess = useCallback(async (enabled: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setPendingMode(enabled ? "on" : "off");
    setExposureError(null);
    // The relaunch can land before this call resolves, so the flag goes first.
    if (enabled) writeResumeFlag();
    try {
      await bridge.setServerExposureMode(enabled ? "network-accessible" : "local-only");
      refreshDesktopNetworkAccessState();
      setConfirmingTurnOff(false);
    } catch (error) {
      if (enabled) clearResumeFlag();
      setExposureError(errorMessage(error, "Could not change network access."));
    } finally {
      setPendingMode(null);
    }
  }, []);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect phone</DialogTitle>
        <DialogDescription>Control ViewCode from the T3 Code mobile app.</DialogDescription>
        <ToggleGroup
          aria-label="Phone connection"
          value={[mode === "local" ? "local" : "anywhere"]}
          disabled={pendingMode !== null}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "local") selectConnectMode("local");
            else if (next === "anywhere") selectConnectMode(anywhereMode);
          }}
        >
          <Toggle value="local">Same Wi-Fi</Toggle>
          <Toggle value="anywhere">Anywhere</Toggle>
        </ToggleGroup>
        {anywhereModes.length > 1 && mode !== "local" ? (
          <ToggleGroup
            aria-label="Anywhere method"
            value={[mode]}
            disabled={pendingMode !== null}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "quick" || next === "tailscale") {
                selectConnectMode(next);
              }
            }}
          >
            {anywhereModes.map((value) => (
              <Toggle key={value} value={value}>
                {MODE_LABELS[value]}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
      </DialogHeader>
      {mode === "quick" ? (
        <DialogPanel>
          {state.kind === "no-server" || state.kind === "no-permission" ? (
            <NotReadyBody state={state} />
          ) : (
            <QuickConnectPhone
              renderQr={(baseUrl, host) => (
                <ReadyBody
                  bare
                  endpoints={[
                    {
                      id: "quick-connect",
                      label: host,
                      httpBaseUrl: baseUrl,
                      loopback: false,
                      lan: false,
                    },
                  ]}
                  note={QUICK_CONNECT_STABLE_NOTE}
                />
              )}
            />
          )}
        </DialogPanel>
      ) : mode === "tailscale" ? (
        <DialogPanel>
          <TailscalePhone
            onBeforeRestart={writeResumeFlag}
            renderQr={(endpoint) => (
              <ReadyBody
                bare
                endpoints={[endpoint]}
                note="Works while this computer and your phone are both on your tailnet."
              />
            )}
          />
        </DialogPanel>
      ) : state.kind === "ready" ? (
        <ReadyBody endpoints={state.endpoints}>
          {exposureError ? (
            <Alert variant="error">
              <AlertDescription>{exposureError}</AlertDescription>
            </Alert>
          ) : null}
        </ReadyBody>
      ) : (
        <DialogPanel>
          <NotReadyBody state={state} />
          {exposureError ? (
            <Alert variant="error">
              <AlertDescription>{exposureError}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
      )}
      {mode !== "local" ? null : state.kind === "needs-network-access" ? (
        <DialogFooter>
          <Button disabled={pendingMode !== null} onClick={() => void setNetworkAccess(true)}>
            {pendingMode === "on" ? <Spinner size="sm" /> : null}
            Turn on and restart
          </Button>
        </DialogFooter>
      ) : state.kind === "ready" && state.canTurnOff ? (
        <DialogFooter className="sm:justify-between">
          {confirmingTurnOff ? (
            <>
              <p className="self-center text-xs text-muted-foreground">
                Local-network connections will stop. ViewCode restarts.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  disabled={pendingMode !== null}
                  onClick={() => setConfirmingTurnOff(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pendingMode !== null}
                  onClick={() => void setNetworkAccess(false)}
                >
                  {pendingMode === "off" ? <Spinner size="sm" /> : null}
                  Turn off and restart
                </Button>
              </div>
            </>
          ) : (
            <Button variant="ghost-destructive" onClick={() => setConfirmingTurnOff(true)}>
              Turn off local network access
            </Button>
          )}
        </DialogFooter>
      ) : null}
    </>
  );
}

function NotReadyBody({ state }: { state: Exclude<ConnectPhoneState, { kind: "ready" }> }) {
  switch (state.kind) {
    case "loading":
      return (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      );
    case "needs-network-access":
      return (
        <p className="text-sm">
          Your phone needs ViewCode to listen on your network. ViewCode will restart once.
        </p>
      );
    case "no-address":
      return (
        <p className="text-sm">
          Phone access is on, but this computer has no network address a phone can reach. Join a
          Wi-Fi network or Tailscale, then open this again.
        </p>
      );
    case "no-permission":
      return (
        <p className="text-sm">
          This browser can't create pairing codes for the server it's connected to. Open Connect
          phone in the ViewCode desktop app on the computer running the server.
        </p>
      );
    case "no-server":
      return (
        <p className="text-sm">
          There is no ViewCode server on this device for a phone to connect to. Open Connect phone
          in the ViewCode desktop app on the computer you want to control.
        </p>
      );
  }
}

type PairingCode = {
  readonly id: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  readonly seenInSnapshot: boolean;
};

function toPairingCode(created: AuthPairingCredentialResult): PairingCode {
  return {
    id: created.id,
    credential: created.credential,
    expiresAtMs: DateTime.toEpochMillis(created.expiresAt),
    seenInSnapshot: false,
  };
}

function revokeUnused(code: PairingCode | null): void {
  if (code === null || code.expiresAtMs <= Date.now()) return;
  // An unused one-time code should not outlive the dialog that showed it.
  void revokeServerPairingLink(code.id).catch(() => undefined);
}

/**
 * Creates a one-time pairing code on mount and on each `createCode`, and
 * tracks it until a device uses it or it expires.
 */
function usePairingCode(endpointId: string) {
  const [counter, setCounter] = useState(0);
  // A new address (the network changed) gets a fresh code, like a manual refresh.
  const request = `${counter}:${endpointId}`;
  const [result, setResult] = useState<{
    readonly request: string;
    readonly code: PairingCode | null;
    readonly error: string | null;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The code still worth revoking when the dialog closes.
  const liveCodeRef = useRef<PairingCode | null>(null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const code = result?.code ?? null;

  useEffect(() => {
    let cancelled = false;
    createServerPairingCredential({
      label: "Phone",
      ttlSeconds: CONNECT_PHONE_CODE_TTL_SECONDS,
    }).then(
      (created) => {
        const next = toPairingCode(created);
        if (cancelled) {
          revokeUnused(next);
          return;
        }
        revokeUnused(liveCodeRef.current);
        liveCodeRef.current = next;
        setNowMs(Date.now());
        setResult({ request, code: next, error: null });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setResult({
          request,
          code: null,
          error: errorMessage(cause, "Could not create a pairing code."),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(
    () => () => {
      revokeUnused(liveCodeRef.current);
      liveCodeRef.current = null;
    },
    [],
  );

  const access = useEnvironmentQuery(
    code !== null && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null })
      : null,
  );
  const inSnapshot =
    code !== null && access.data?.type === "snapshot"
      ? access.data.payload.pairingLinks.some((link) => link.id === code.id)
      : false;
  if (result && code && inSnapshot && !code.seenInSnapshot) {
    setResult({ ...result, code: { ...code, seenInSnapshot: true } });
  }

  const status =
    code === null
      ? null
      : resolvePairingCodeStatus({
          expiresAtMs: code.expiresAtMs,
          nowMs,
          seenInSnapshot: code.seenInSnapshot,
          inSnapshot,
        });
  // A used code is gone server-side; there is nothing left to revoke.
  useEffect(() => {
    if (status === "paired") liveCodeRef.current = null;
  }, [status]);

  // One timer flips the code to expired; nothing repaints in between.
  useEffect(() => {
    if (code === null) return;
    const delay = code.expiresAtMs - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay + 250);
    return () => window.clearTimeout(timer);
  }, [code]);

  const createCode = useCallback(() => setCounter((current) => current + 1), []);
  return {
    code,
    status,
    error: result?.error ?? null,
    isCreating: result?.request !== request,
    createCode,
  };
}

/**
 * Asks the desktop to call its own LAN address over HTTP, only when the user
 * clicks "Test this network". Never on open: on a managed Mac, security
 * software can read an app connecting to its own LAN address as network
 * reconnaissance and kill the whole process tree. Web and `npx t3` clients
 * have no desktop bridge and never offer it.
 */
function useLanSelfTest(endpoint: PhoneEndpoint | undefined) {
  const check = window.desktopBridge?.checkLanReachability;
  const available = canTestLanReachability({ canCheck: check !== undefined, endpoint });
  const url = endpoint?.httpBaseUrl ?? "";
  const [run, setRun] = useState<{ readonly url: string; readonly id: number } | null>(null);
  const [settled, setSettled] = useState<{
    readonly id: number;
    readonly value: DesktopLanReachability | null;
  } | null>(null);
  const current = run !== null && run.url === url ? run : null;
  useEffect(() => {
    if (current === null || check === undefined) return;
    let cancelled = false;
    check().then(
      (value) => {
        if (!cancelled) setSettled({ id: current.id, value });
      },
      () => {
        if (!cancelled) setSettled({ id: current.id, value: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [check, current]);
  const start = useCallback(
    () => setRun((previous) => ({ url, id: (previous?.id ?? 0) + 1 })),
    [url],
  );
  const done = current !== null && settled?.id === current.id;
  return {
    available,
    checking: available && current !== null && !done,
    result: available && done ? settled.value : null,
    start,
  };
}

function ReadyBody({
  endpoints,
  children,
  bare = false,
  note = "Works on the same Wi-Fi as this computer.",
}: {
  endpoints: ReadonlyArray<PhoneEndpoint>;
  children?: ReactNode;
  /** Render inside a panel the caller already provides. */
  bare?: boolean;
  note?: string;
}) {
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "pairing link" });
  const endpoint = endpoints.find((candidate) => candidate.id === endpointId) ?? endpoints[0];
  const {
    code,
    status,
    error,
    isCreating,
    createCode: createFreshCode,
  } = usePairingCode(endpoint?.id ?? "");
  const lanTest = useLanSelfTest(endpoint);
  const createCode = useCallback(() => {
    if (window.desktopBridge) refreshDesktopNetworkAccessState();
    createFreshCode();
  }, [createFreshCode]);
  if (!endpoint) return null;
  const pairingUrl = code ? resolveDesktopPairingUrl(endpoint.httpBaseUrl, code.credential) : null;
  const lanWarning = describeLanReachability(lanTest.result, endpoint.httpBaseUrl);

  const Panel = bare ? Fragment : DialogPanel;
  return (
    <Panel>
      <ol className="space-y-1.5 text-sm">
        <Step n={1}>Install T3 Code from the App Store or Google Play.</Step>
        <Step n={2}>Open it and tap Add environment.</Step>
        <Step n={3}>Scan this code.</Step>
      </ol>

      <div className="flex flex-col items-center gap-3">
        {endpoint.loopback ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>
              This page is open at {endpoint.label}, which only this computer can reach. Open
              ViewCode at this computer's network address, or use the desktop app.
            </AlertDescription>
          </Alert>
        ) : error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : pairingUrl && status === "active" ? (
          <div className="rounded-xl bg-white p-3">
            <QRCodeSvg
              value={pairingUrl}
              size={224}
              level="M"
              marginSize={1}
              title="Pairing code for the T3 Code mobile app"
            />
          </div>
        ) : status === "paired" ? (
          <div className="flex size-62 flex-col items-center justify-center gap-2 rounded-xl border text-center">
            <CheckIcon className="size-6 text-success" />
            <p className="text-sm font-medium">Phone connected</p>
            <p className="px-6 text-xs text-muted-foreground">
              Each code works once. Make a new one for another device.
            </p>
          </div>
        ) : status === "expired" ? (
          <div className="flex size-62 flex-col items-center justify-center gap-2 rounded-xl border text-center">
            <p className="text-sm font-medium">This code expired</p>
          </div>
        ) : (
          <div className="flex size-62 items-center justify-center rounded-xl border">
            <Spinner />
          </div>
        )}

        {lanWarning ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>{lanWarning}</AlertDescription>
          </Alert>
        ) : lanTest.checking ? (
          <p className="text-xs text-muted-foreground">
            Checking that phones can reach this computer…
          </p>
        ) : lanTest.result?.status === "ok" ? (
          <p className="text-xs text-muted-foreground">Phones on this network can reach it.</p>
        ) : lanTest.available ? (
          <Button size="xs" variant="ghost" onClick={lanTest.start}>
            Test this network
          </Button>
        ) : null}

        {code && status === "active" && !endpoint.loopback ? (
          <p className="text-center text-xs text-muted-foreground">
            This code works once. Expires at {formatPairingExpiry(code.expiresAtMs)}.
          </p>
        ) : null}

        {!endpoint.loopback && (status === "expired" || status === "paired" || error) ? (
          <Button size="sm" disabled={isCreating} onClick={createCode}>
            {isCreating ? <Spinner size="sm" /> : null}
            New code
          </Button>
        ) : null}
      </div>

      {code && pairingUrl && status === "active" && !endpoint.loopback ? (
        <div className="space-y-1.5">
          <InputGroup>
            <InputGroupInput
              size="sm"
              readOnly
              value={pairingUrl}
              aria-label="Pairing link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Copy pairing link"
                onClick={() => copyToClipboard(pairingUrl, undefined)}
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </InputGroupAddon>
          </InputGroup>
          <p className="text-xs text-muted-foreground">Treat this link like a password.</p>
        </div>
      ) : null}

      <div className="space-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <SmartphoneIcon className="size-3.5 shrink-0" />
          {endpoints.length > 1 ? (
            <Select
              value={endpoint.id}
              onValueChange={(value) => {
                if (typeof value === "string") setEndpointId(value);
              }}
            >
              <SelectTrigger size="xs" aria-label="Network address the code uses">
                <SelectValue>{describeEndpoint(endpoint)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {endpoints.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {describeEndpoint(candidate)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <span className="min-w-0 truncate">Uses {describeEndpoint(endpoint)}</span>
          )}
        </div>
        <p>{note}</p>
      </div>
      {children}
    </Panel>
  );
}

function describeEndpoint(endpoint: PhoneEndpoint): string {
  try {
    const host = new URL(endpoint.httpBaseUrl).host;
    return host === endpoint.label ? host : `${endpoint.label} · ${host}`;
  } catch {
    return endpoint.label;
  }
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
