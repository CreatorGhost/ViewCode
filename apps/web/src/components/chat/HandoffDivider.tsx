import { useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon, ArrowRightLeftIcon, CheckIcon, CopyIcon } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { WorkLogEntry } from "../../session-logic";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import {
  resolveHandoffView,
  type HandoffEndpointView,
  type HandoffInstanceInfo,
} from "./HandoffDivider.logic";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

type IconComponent = React.ComponentType<{ className?: string }>;

function EndpointGlyph({ endpoint }: { endpoint: HandoffEndpointView }) {
  const Icon = endpoint.driver
    ? (PROVIDER_ICON_BY_PROVIDER as Record<string, IconComponent>)[endpoint.driver]
    : undefined;
  return Icon ? <Icon className="size-3.5 shrink-0" /> : null;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function EndpointDetail({ endpoint }: { endpoint: HandoffEndpointView }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <EndpointGlyph endpoint={endpoint} />
      <span className="truncate">
        {[endpoint.providerName, endpoint.modelName].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

const HairLine = () => <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />;

/**
 * The transcript boundary for a provider/account switch (or a recap restart):
 * a quiet hairline with the move on it, expanding to what was carried over.
 */
export const HandoffDivider = memo(function HandoffDivider({
  entry,
  label,
}: {
  entry: { label: string; handoff?: WorkLogEntry["handoff"] | undefined };
  label: string;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const instances = useMemo(
    () =>
      new Map<string, HandoffInstanceInfo>(
        providers.map((provider) => [
          provider.instanceId as string,
          {
            driver: provider.driver as string,
            displayName: provider.displayName,
            models: provider.models,
          },
        ]),
      ),
    [providers],
  );
  const view = useMemo(() => resolveHandoffView(entry, instances), [entry, instances]);
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  const summary = entry.handoff?.summary;

  if (!view) {
    return (
      <div
        role="separator"
        aria-label={label}
        data-timeline-handoff=""
        className="mx-auto flex w-full max-w-chat items-center gap-3 py-3 text-muted-foreground text-xs"
      >
        <HairLine />
        <span className="flex min-w-0 items-center gap-1.5">
          <ArrowRightLeftIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <HairLine />
      </div>
    );
  }

  return (
    <div data-timeline-handoff="" className="mx-auto w-full max-w-chat py-3 text-xs">
      <div className="flex items-center gap-3">
        <HairLine />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRightLeftIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="shrink-0">{view.header}</span>
          <span aria-hidden="true">·</span>
          <EndpointGlyph endpoint={view.from} />
          <span className="truncate">{view.from.collapsedName}</span>
          <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
          <EndpointGlyph endpoint={view.to} />
          <span className="truncate text-foreground/85">{view.to.collapsedName}</span>
        </button>
        <HairLine />
      </div>
      {open ? (
        <div
          id={regionId}
          className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
        >
          <dl className="space-y-1.5">
            <DetailRow label="From">
              <EndpointDetail endpoint={view.from} />
            </DetailRow>
            <DetailRow label="To">
              <EndpointDetail endpoint={view.to} />
            </DetailRow>
            {view.contextLabel ? (
              <DetailRow label="Context">
                {view.contextLabel}
                {view.charCount !== null ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {view.charCount.toLocaleString("en-US")} characters
                  </span>
                ) : null}
              </DetailRow>
            ) : null}
          </dl>
          {summary ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Transferred context</span>
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={isCopied ? "Copied" : "Copy transferred context"}
                  onClick={() => copyToClipboard(summary, undefined)}
                >
                  {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                </Button>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {summary}
              </pre>
            </div>
          ) : null}
          <p className="text-muted-foreground">
            Sent ahead of your next message so the new model can continue this thread.
          </p>
          {entry.handoff?.transcriptPath ? (
            <p className="select-text break-all text-muted-foreground">
              Full transcript: {entry.handoff.transcriptPath}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
