import type {
  ViewCodeRelaySetupStartInput,
  ViewCodeRelaySetupState,
  ViewCodeRelayState,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GlobeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { authEnvironment } from "~/state/auth";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { viewCodeRelaySetupEnvironment } from "~/state/viewcodeRelaySetup";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import {
  CLOUDFLARE_SIGN_UP_URL,
  CLOUDFLARE_WORKERS_URL,
  NODE_DOWNLOAD_URL,
  QUICK_CONNECT_TRAFFIC_NOTE,
  resolveQuickConnectView,
  resolveSetupChecklist,
} from "./connectPhone.logic";

function usePrimaryAccessSnapshot() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const access = useEnvironmentQuery(
    primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({ environmentId: primaryEnvironmentId, input: null })
      : null,
  );
  return access.data?.type === "snapshot" ? access.data.payload : null;
}

/** The relay connection's state, pushed by the server on the access stream; null until it arrives. */
export function useViewCodeRelayState(): ViewCodeRelayState | null {
  return usePrimaryAccessSnapshot()?.viewcodeRelay ?? null;
}

/** Setup progress, on the same stream; null for sessions that may not run setup. */
export function useViewCodeRelaySetupState(): ViewCodeRelaySetupState | null {
  return usePrimaryAccessSnapshot()?.viewcodeRelaySetup ?? null;
}

/** Opens a link in the person's browser (the desktop shell, or a new tab). */
function openLink(url: string): void {
  void readLocalApi()?.shell.openExternal(url);
}

/** Sign-in links already opened for the person, so reopening the dialog does not open them again. */
const autoOpenedSignInLinks = new Set<string>();

function useRelaySetupActions() {
  const environmentId = usePrimaryEnvironmentId();
  const start = useAtomCommand(viewCodeRelaySetupEnvironment.start);
  const cancel = useAtomCommand(viewCodeRelaySetupEnvironment.cancel);
  const continueSetup = useAtomCommand(viewCodeRelaySetupEnvironment.continueSetup);
  const remove = useAtomCommand(viewCodeRelaySetupEnvironment.remove);
  return {
    start: (input: ViewCodeRelaySetupStartInput) => {
      if (environmentId !== null) void start({ environmentId, input });
    },
    cancel: () => {
      if (environmentId !== null) void cancel({ environmentId, input: {} });
    },
    continueSetup: () => {
      if (environmentId !== null) void continueSetup({ environmentId, input: {} });
    },
    remove: (localOnly: boolean) => {
      if (environmentId !== null) void remove({ environmentId, input: { localOnly } });
    },
  };
}

type SetupActions = ReturnType<typeof useRelaySetupActions>;

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label });
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Copy ${label}`}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

function Details({ text }: { readonly text: string | undefined }) {
  if (!text) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        Details
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs select-text">
          {text}
        </pre>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function CreateAccountLink() {
  return (
    <p className="text-xs text-muted-foreground">
      No Cloudflare account?{" "}
      <a
        className="underline underline-offset-4"
        href={CLOUDFLARE_SIGN_UP_URL}
        target="_blank"
        rel="noreferrer"
      >
        Create one free
      </a>
      , then come back here.
    </p>
  );
}

/** Sign-in screen: the page and code to approve ViewCode on Cloudflare. */
function SignInPrompt({ signIn }: { readonly signIn: ViewCodeRelaySetupState["signIn"] }) {
  const openUrl = signIn?.openUrl ?? signIn?.url;
  // The desktop app opens the page itself; a browser tab would block a pop-up
  // that no click started, so there the person uses the button.
  useEffect(() => {
    if (!openUrl || !window.desktopBridge || autoOpenedSignInLinks.has(openUrl)) return;
    autoOpenedSignInLinks.add(openUrl);
    openLink(openUrl);
  }, [openUrl]);

  if (!signIn?.url && !signIn?.code) {
    if (!signIn || signIn.lines.length === 0) return null;
    return (
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs select-text">
        {signIn.lines.join("\n")}
      </pre>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm">
        {window.desktopBridge
          ? "Approve ViewCode in the browser window that opened. If it did not open, open the link and enter this code."
          : "Open the link and enter this code to approve ViewCode."}
      </p>
      {signIn.code ? (
        <div className="flex items-center justify-center gap-2">
          <span className="font-mono text-2xl tracking-widest select-all">{signIn.code}</span>
          <CopyButton value={signIn.code} label="sign-in code" />
        </div>
      ) : null}
      {signIn.url ? (
        <div className="flex items-center gap-1">
          <a
            className="min-w-0 truncate text-xs text-muted-foreground underline underline-offset-4 select-all"
            href={openUrl}
            target="_blank"
            rel="noreferrer"
          >
            {signIn.url}
          </a>
          <CopyButton value={signIn.url} label="sign-in link" />
        </div>
      ) : null}
      {openUrl ? (
        <Button variant="outline" size="sm" onClick={() => openLink(openUrl)}>
          <ExternalLinkIcon />
          {window.desktopBridge ? "Open link again" : "Open link"}
        </Button>
      ) : null}
    </div>
  );
}

function SetupProgress({
  setup,
  actions,
}: {
  readonly setup: ViewCodeRelaySetupState;
  readonly actions: SetupActions;
}) {
  const removing = setup.step === "removing";
  return (
    <div className="space-y-3">
      {removing ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Spinner size="sm" />
          {setup.message ?? "Removing Quick connect…"}
        </p>
      ) : (
        <ol className="space-y-2">
          {resolveSetupChecklist(setup.step, setup.message).map((row) => (
            <li key={row.label} className="text-sm">
              <div className="flex items-center gap-2">
                {row.state === "done" ? (
                  <CheckIcon className="size-4 text-success" />
                ) : row.state === "current" ? (
                  <Spinner size="sm" />
                ) : (
                  <CircleIcon className="size-4 text-muted-foreground/50" />
                )}
                <span className={row.state === "pending" ? "text-muted-foreground" : undefined}>
                  {row.label}
                </span>
              </div>
              {row.note === undefined ? null : (
                <p role="status" className="mt-1 pl-6 text-muted-foreground">
                  {row.note}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {setup.step === "signing-in" ? (
        <>
          <SignInPrompt signIn={setup.signIn} />
          <CreateAccountLink />
        </>
      ) : null}
      <div>
        <Button variant="outline" size="sm" onClick={actions.cancel}>
          Cancel
        </Button>
      </div>
      <Details text={setup.details} />
    </div>
  );
}

/**
 * After "Open Cloudflare" the person picks a subdomain in the browser; when
 * they come back to this window, setup continues once on its own.
 */
function SubdomainNeeded({
  setup,
  actions,
}: {
  readonly setup: ViewCodeRelaySetupState;
  readonly actions: SetupActions;
}) {
  const armed = useRef(false);
  const { continueSetup } = actions;
  const onFocus = useCallback(() => {
    if (!armed.current) return;
    armed.current = false;
    continueSetup();
  }, [continueSetup]);
  useEffect(() => {
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onFocus]);

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {setup.message ??
          "Your Cloudflare account needs a free workers.dev address first. Open Cloudflare, choose one under Workers & Pages, then come back."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            armed.current = true;
            openLink(CLOUDFLARE_WORKERS_URL);
          }}
        >
          <ExternalLinkIcon />
          Open Cloudflare
        </Button>
        <Button variant="outline" onClick={continueSetup}>
          Continue
        </Button>
        <Button variant="ghost" onClick={actions.cancel}>
          Back
        </Button>
      </div>
      <Details text={setup.details} />
    </div>
  );
}

function RelayMenu({
  enabled,
  actions,
  onTurnOff,
}: {
  readonly enabled: boolean;
  readonly actions: SetupActions;
  readonly onTurnOff: () => void;
}) {
  const confirmRemove = async () => {
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          "Remove Quick connect?\nThis deletes the relay from your Cloudflare account and forgets it on this computer. Phones paired through it stop reaching this computer.",
          { variant: "destructive" },
        )
      : true;
    if (confirmed) actions.remove(false);
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Quick connect options"
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {enabled ? <MenuItem onClick={onTurnOff}>Turn off Quick connect</MenuItem> : null}
        <MenuItem onClick={() => actions.start({ mode: "redeploy" })}>Redeploy relay</MenuItem>
        <MenuItem onClick={() => actions.start({ mode: "redeploy", rotateSecret: true })}>
          Redeploy with a new secret
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => void confirmRemove()}>
          Remove Quick connect
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The Quick connect tab: this computer dials out to the person's own
 * Cloudflare relay, so a phone can reach it where tunnels are blocked. Setup
 * runs on the server (sign in, deploy, secret, verify); the connection's
 * state and the setup's progress both arrive on the access stream.
 */
export function QuickConnectPhone({
  renderQr,
}: {
  /** The pairing QR for the relay's address; shown only while the relay connection is up. */
  readonly renderQr: (baseUrl: string, host: string) => ReactNode;
}) {
  const relay = useViewCodeRelayState();
  const setup = useViewCodeRelaySetupState();
  const updateSettings = useUpdatePrimarySettings();
  const actions = useRelaySetupActions();
  const view = resolveQuickConnectView(relay);
  const setEnabled = (enabled: boolean) => updateSettings({ viewcodeRelay: { enabled } });
  const turnOff = () => setEnabled(false);

  const trafficNote = <p className="text-xs text-muted-foreground">{QUICK_CONNECT_TRAFFIC_NOTE}</p>;
  const setupStatus = setup?.status ?? "idle";

  if (setup !== null && setupStatus === "running") {
    return (
      <div className="space-y-3">
        <SetupProgress setup={setup} actions={actions} />
        {trafficNote}
      </div>
    );
  }
  if (setup !== null && setupStatus === "needs-subdomain") {
    return <SubdomainNeeded setup={setup} actions={actions} />;
  }
  if (setup !== null && setupStatus === "failed") {
    return (
      <div className="space-y-3">
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertDescription>{setup.message ?? "Setup did not finish."}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          {setup.action === "install-node" ? (
            <Button onClick={() => openLink(NODE_DOWNLOAD_URL)}>
              <ExternalLinkIcon />
              Install Node.js
            </Button>
          ) : null}
          <Button
            variant={setup.action === "install-node" ? "outline" : "default"}
            onClick={() => actions.start({ mode: view.kind === "not-set-up" ? "new" : "redeploy" })}
          >
            Try again
          </Button>
          <Button variant="ghost" onClick={actions.cancel}>
            Back
          </Button>
        </div>
        <Details text={setup.details} />
      </div>
    );
  }
  if (setup !== null && setupStatus === "remove-failed") {
    return (
      <div className="space-y-3">
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertDescription>{setup.message}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => actions.remove(false)}>Try again</Button>
          <Button variant="outline" onClick={() => actions.remove(true)}>
            Remove from this computer only
          </Button>
          <Button variant="ghost" onClick={actions.cancel}>
            Back
          </Button>
        </div>
        <Details text={setup.details} />
      </div>
    );
  }

  // Set up (or never set up): the connection's own state decides.
  const setupNote =
    setupStatus === "unreachable" || (setupStatus === "idle" && setup?.message) ? (
      <p className="text-xs text-muted-foreground">{setup?.message}</p>
    ) : null;
  const header = (enabled: boolean) => (
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium">Quick connect</p>
      <RelayMenu enabled={enabled} actions={actions} onTurnOff={turnOff} />
    </div>
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
                block tunnels. ViewCode sets up a small relay on your own free Cloudflare account.
              </p>
            </div>
          </div>
          {setupNote}
          <div>
            <Button onClick={() => actions.start({ mode: "new" })}>Connect with Cloudflare</Button>
          </div>
          <CreateAccountLink />
        </>
      ) : null}

      {view.kind === "off" ? (
        <>
          {header(false)}
          <p className="text-sm">
            Your relay is set up but turned off. Turn it on to show a code for your phone.
          </p>
          {setupNote}
          <div>
            <Button onClick={() => actions.start({ mode: "reuse" })}>Use existing relay</Button>
          </div>
        </>
      ) : null}

      {view.kind === "connecting" || view.kind === "reconnecting" ? (
        <>
          {header(true)}
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {view.kind === "connecting"
              ? "Connecting to your relay…"
              : "Reconnecting to your relay…"}
          </p>
          {setupNote ??
            (view.kind === "reconnecting" && view.reason ? (
              <p className="text-xs text-muted-foreground">{view.reason}</p>
            ) : null)}
          {setup?.problem === "credential-rejected" ? (
            <div>
              <Button onClick={() => actions.start({ mode: "redeploy", rotateSecret: true })}>
                Redeploy with a new secret
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {view.kind === "blocked" ? (
        <>
          {header(true)}
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>
              {view.reason ??
                "This network's security certificate is not trusted by this computer."}{" "}
              ViewCode keeps trying and will connect as soon as the network allows it.
            </AlertDescription>
          </Alert>
        </>
      ) : null}

      {view.kind === "auth-failed" ? (
        <>
          {header(true)}
          <Alert variant="error">
            <AlertDescription>
              {view.reason ?? "The relay did not accept this computer's secret."}
            </AlertDescription>
          </Alert>
          <div>
            <Button onClick={() => actions.start({ mode: "redeploy", rotateSecret: true })}>
              Redeploy with a new secret
            </Button>
          </div>
        </>
      ) : null}

      {view.kind === "ready" ? (
        <>
          {header(true)}
          {renderQr(view.baseUrl, view.host)}
        </>
      ) : null}

      {view.kind !== "loading" ? trafficNote : null}
    </div>
  );
}
