import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon, CornerUpLeftIcon, InboxIcon, SendIcon } from "lucide-react";
import {
  ThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AgentMessageEnvelope, AgentMessageSentPayload } from "@t3tools/shared/agentMessages";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import { agentMessageBodyIsLong } from "./agentTimeline.logic";

interface AgentMessageRenderContext {
  readonly environmentId: EnvironmentId;
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}

/** The other agent's name; links to its thread when that thread exists here. */
function AgentThreadName({
  environmentId,
  threadId,
  name,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  name: string;
}) {
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(threadId)),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  const label = name.trim() || "agent";
  if (!shell) {
    return <span className="truncate font-medium text-foreground">{label}</span>;
  }
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="truncate font-medium text-foreground no-underline hover:underline focus-visible:outline-2 focus-visible:outline-foreground"
    >
      {label}
    </Link>
  );
}

/** Bordered card shared by incoming and outgoing agent messages; the body clamps to three lines. */
function AgentMessageCardFrame({
  header,
  body,
  context,
  dataAttributes,
}: {
  header: ReactNode;
  body: string;
  context: AgentMessageRenderContext;
  dataAttributes: Record<`data-${string}`, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = agentMessageBodyIsLong(body);
  const clamped = long && !expanded;
  return (
    <div
      className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-card/40 px-3 py-2"
      {...dataAttributes}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        {header}
        {long ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            className="ml-auto"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse message" : "Expand message"}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
            />
          </Button>
        ) : null}
      </div>
      {body.trim().length > 0 ? (
        <div
          className={cn(
            "mt-1 text-sm",
            clamped &&
              "max-h-[4.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
          )}
        >
          <ChatMarkdown
            className="text-foreground"
            text={body}
            cwd={context.markdownCwd}
            threadRef={context.threadRef ?? undefined}
            lineBreaks
            skills={context.skills}
            headingLevelOffset={3}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A message another agent delivered to this thread: "✉ from <name>". */
export function IncomingAgentMessageCard({
  envelope,
  context,
}: {
  envelope: AgentMessageEnvelope;
  context: AgentMessageRenderContext;
}) {
  return (
    <AgentMessageCardFrame
      body={envelope.body}
      context={context}
      dataAttributes={{ "data-agent-message-id": envelope.messageId }}
      header={
        <>
          <InboxIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">from</span>
          <AgentThreadName
            environmentId={context.environmentId}
            threadId={envelope.fromThreadId}
            name={envelope.fromName}
          />
          {envelope.inReplyTo ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <CornerUpLeftIcon aria-hidden className="size-3" />
              reply to your message
            </span>
          ) : envelope.replyExpected ? (
            <Badge size="sm" variant="info">
              Reply expected
            </Badge>
          ) : null}
        </>
      }
    />
  );
}

/** A message this thread's agent sent: "➤ to <name> ↩", or "Started <name>" for a spawn. */
export function OutgoingAgentMessageCard({
  sent,
  context,
}: {
  sent: AgentMessageSentPayload;
  context: AgentMessageRenderContext;
}) {
  const isSpawn = sent.kind === "spawn";
  return (
    <AgentMessageCardFrame
      body={sent.body}
      context={context}
      dataAttributes={{ "data-agent-message-id": sent.messageId }}
      header={
        <>
          {isSpawn ? (
            <BotIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <SendIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="shrink-0">{isSpawn ? "Started" : "to"}</span>
          <AgentThreadName
            environmentId={context.environmentId}
            threadId={sent.toThreadId}
            name={sent.toName}
          />
          {sent.replyExpected ? (
            <CornerUpLeftIcon aria-label="Reply expected" className="size-3 shrink-0" />
          ) : null}
          {sent.delivery === "queued" ? (
            <Badge size="sm" variant="warning">
              queued
            </Badge>
          ) : null}
        </>
      }
    />
  );
}
