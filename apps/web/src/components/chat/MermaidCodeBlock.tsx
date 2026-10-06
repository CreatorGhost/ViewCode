import { CodeIcon, Maximize2Icon, WorkflowIcon } from "lucide-react";
import { type ReactNode, Suspense, useState } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MermaidDiagram } from "./MermaidDiagram";

export interface MermaidCodeBlockFrame {
  readonly title: ReactNode;
  readonly actions: ReactNode;
  readonly canWrap: boolean;
  readonly body: ReactNode;
}

function HeaderAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={onClick}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A mermaid fence renders as a diagram once its closing fence has arrived, so
 * a block still streaming never re-lays out on every token. Until then, behind
 * the source toggle, and when Mermaid cannot parse it, it keeps the
 * highlighted `source`. The caller draws the frame so it matches code blocks.
 */
export function MermaidCodeBlock({
  code,
  fenceTitle,
  ready,
  source,
  children: renderFrame,
}: {
  code: string;
  fenceTitle: string | null;
  ready: boolean;
  source: ReactNode;
  children: (frame: MermaidCodeBlockFrame) => ReactNode;
}) {
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Keyed by source, so an edited fence gets a fresh attempt.
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const failed = failedCode === code;
  const showDiagram = !showSource && ready && code.trim().length > 0;
  const toggleLabel = showSource ? "Show diagram" : "Show source";

  return renderFrame({
    title: (
      <>
        <WorkflowIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{fenceTitle ?? "Diagram"}</span>
      </>
    ),
    actions:
      ready && !failed ? (
        <>
          <HeaderAction label={toggleLabel} onClick={() => setShowSource((value) => !value)}>
            {showSource ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
          </HeaderAction>
          {showDiagram ? (
            <HeaderAction label="Expand diagram" onClick={() => setExpanded(true)}>
              <Maximize2Icon className="size-3" />
            </HeaderAction>
          ) : null}
        </>
      ) : null,
    canWrap: !showDiagram || failed,
    body: showDiagram ? (
      <RenderErrorBoundary resetKeys={[code]} fallback={source}>
        <Suspense
          fallback={
            <div className="flex min-h-36 items-center justify-center text-xs text-muted-foreground">
              Rendering diagram
            </div>
          }
        >
          <MermaidDiagram
            source={code}
            fallback={source}
            expanded={expanded}
            onExpandedChange={setExpanded}
            onFailedChange={(nextFailed) => setFailedCode(nextFailed ? code : null)}
          />
        </Suspense>
      </RenderErrorBoundary>
    ) : (
      source
    ),
  });
}
