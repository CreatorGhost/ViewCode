import { type CSSProperties, useId } from "react";

import { cn } from "~/lib/utils";
import { type PrFlow, prFlowConflictCount, prFlowReached } from "./prFlowModel";

const delay = (ms: number, duration?: number) =>
  ({
    "--pr-map-delay": `${ms}ms`,
    ...(duration === undefined ? {} : { "--pr-map-duration": `${duration}ms` }),
  }) as CSSProperties;

/**
 * The pull request as a branch map: the base runs across the top, the branch curves below it
 * with its commits, and each stage draws in as the flow reaches it (index.css, PR branch map).
 * Geometry is a fixed 560×100 drawing that scales with the card.
 */
export function PrBranchMap({ flow }: { flow: PrFlow }) {
  const maskId = `${useId()}-conflict`;
  const reached = (phase: Parameters<typeof prFlowReached>[1]) => prFlowReached(flow.phase, phase);
  const merged = flow.phase === "merged";
  const conflictShown = reached("checking") && !reached("resolving");
  const show = (visible: boolean, motion: "draw" | "pop") =>
    visible ? `pr-map-${motion}` : "pr-map-hidden";
  const branchTone = merged ? "text-branch" : "text-primary";

  return (
    <div className="relative rounded-lg bg-muted/40 px-1.5 py-1">
      <div className="relative aspect-[560/100] w-full">
        <svg
          viewBox="0 0 560 100"
          aria-hidden
          className="absolute inset-0 size-full overflow-visible"
          fill="none"
        >
          <defs>
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="560"
              height="100"
              style={{ maskType: "alpha" }}
            >
              <path
                className={show(reached("checking"), "draw")}
                style={delay(0, 620)}
                pathLength={1}
                d="M336 72 C420 72 452 34 528 34"
                stroke="currentColor"
                strokeWidth={8}
              />
            </mask>
          </defs>
          <path
            className="pr-map-draw text-border"
            style={delay(0, 620)}
            pathLength={1}
            d="M24 34 H540"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <g className="fill-muted-foreground/70">
            <circle className="pr-map-pop" style={delay(80)} cx={24} cy={34} r={3.4} />
            <circle className="pr-map-pop" style={delay(160)} cx={96} cy={34} r={3.4} />
            <circle className={show(reached("fetching"), "pop")} cx={300} cy={34} r={3.4} />
            <circle
              className={show(reached("fetching"), "pop")}
              style={delay(120)}
              cx={390}
              cy={34}
              r={3.4}
            />
          </g>
          <g className={cn("transition-colors duration-500", branchTone)} stroke="currentColor">
            <path
              className="pr-map-draw"
              style={delay(240, 560)}
              pathLength={1}
              d="M96 34 C134 34 134 72 172 72 H254"
              strokeWidth={1.6}
            />
            <path
              className={flow.phase === "committing" ? "pr-map-pulse" : "pr-map-fade"}
              d="M254 72 H336"
              strokeWidth={1.6}
              strokeDasharray="2 4"
              strokeLinecap="round"
            />
            <path
              className={show(reached("pushing"), "draw")}
              style={delay(0, 320)}
              pathLength={1}
              d="M254 72 H336"
              strokeWidth={1.6}
            />
            <path
              className={show(reached("resolving"), "draw")}
              style={delay(0, 420)}
              pathLength={1}
              d="M336 72 H440"
              strokeWidth={1.6}
            />
          </g>
          <path
            className={cn(show(reached("resolving"), "draw"), "text-muted-foreground/70")}
            style={delay(120, 520)}
            pathLength={1}
            d="M390 34 C414 34 416 72 440 72"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <g mask={`url(#${maskId})`}>
            <path
              className={cn(
                "text-warning",
                conflictShown ? undefined : reached("resolving") ? "pr-map-fade" : "pr-map-hidden",
              )}
              d="M336 72 C420 72 452 34 528 34"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="3 4"
            />
          </g>
          <path
            className={cn(show(merged, "draw"), "text-branch")}
            style={delay(0, 560)}
            pathLength={1}
            d="M440 72 C478 72 490 34 528 34"
            stroke="currentColor"
            strokeWidth={2}
          />
          <g className={cn("transition-colors duration-500", branchTone)} fill="currentColor">
            <circle className="pr-map-pop" style={delay(560)} cx={172} cy={72} r={3.6} />
            <circle className="pr-map-pop" style={delay(640)} cx={254} cy={72} r={3.6} />
            <circle className={show(reached("pushing"), "pop")} cx={336} cy={72} r={3.6} />
          </g>
          <circle
            className={cn(
              flow.phase === "committing" ? "pr-map-pulse" : "pr-map-fade",
              "fill-background text-primary",
            )}
            cx={336}
            cy={72}
            r={4}
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <circle
            className={cn(
              show(reached("resolving"), "pop"),
              "fill-background text-muted-foreground",
            )}
            style={delay(520)}
            cx={440}
            cy={72}
            r={4}
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <g
            className={cn(
              "text-warning",
              conflictShown ? "pr-map-pop" : reached("resolving") ? "pr-map-fade" : "pr-map-hidden",
            )}
            style={delay(560)}
          >
            <circle cx={528} cy={34} r={5.5} fill="currentColor" />
            <path
              d="M528 31 v3.6 M528 37.2 v.2"
              className="stroke-background"
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          </g>
          <g className="text-branch">
            <circle
              className={merged ? "pr-map-ring" : "pr-map-hidden"}
              style={delay(520)}
              cx={528}
              cy={34}
              r={5.5}
              stroke="currentColor"
              strokeWidth={1.5}
            />
            <circle
              className={show(merged, "pop")}
              style={delay(520)}
              cx={528}
              cy={34}
              r={5}
              fill="currentColor"
            />
          </g>
        </svg>
        <span className="absolute top-[6%] left-[3%] rounded bg-muted/80 px-1 font-mono text-2xs text-muted-foreground">
          {flow.base ?? "base"}
        </span>
        <span
          className={cn(
            "absolute top-[80%] left-[30%] font-mono text-2xs transition-colors duration-500",
            branchTone,
          )}
        >
          {flow.head}
        </span>
        {conflictShown && flow.conflicts ? (
          <span
            key="conflicts"
            className="pr-flow-swap absolute -top-1 right-[2%] rounded-full border border-warning/40 bg-warning-surface px-2 text-2xs text-warning-foreground"
          >
            {prFlowConflictCount(flow) === 0
              ? "Conflicts"
              : `${prFlowConflictCount(flow)} conflicts`}
          </span>
        ) : null}
        {merged ? (
          <span
            key="merged"
            className="pr-flow-swap absolute -top-1 right-[2%] rounded-full border border-branch/30 bg-branch/10 px-2 text-2xs text-branch"
          >
            Merged
          </span>
        ) : null}
      </div>
    </div>
  );
}
