import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  structuralProtocolMethod,
  summarizeNativeProtocolPayload,
} from "@t3tools/provider-core/server/nativeProtocolLogging";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const transientProtocolUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

function summarizeMcpAttachment(method: string, payload: unknown) {
  if (method !== "session/new" && method !== "session/load" && method !== "session/resume")
    return {};
  if (payload === null || typeof payload !== "object") return {};
  try {
    const servers: unknown = Reflect.get(payload, "mcpServers");
    if (!Array.isArray(servers)) return {};
    const transports = new Set<"http" | "sse" | "stdio" | "acp" | "unknown">();
    for (const server of servers) {
      if (server === null || typeof server !== "object") {
        transports.add("unknown");
        continue;
      }
      const type: unknown = Reflect.get(server, "type");
      if (type === "http" || type === "sse" || type === "stdio" || type === "acp")
        transports.add(type);
      // ACP v1 stdio entries have no discriminator.
      else if (type === undefined && typeof Reflect.get(server, "command") === "string")
        transports.add("stdio");
      else transports.add("unknown");
    }
    return {
      mcpServerCount: servers.length,
      mcpTransports: [...transports],
      // Attachment describes the request; the agent has not confirmed tool discovery.
      toolsAvailability: "unverified",
    };
  } catch {
    return {};
  }
}

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  return {
    method: structuralProtocolMethod(event.method),
    status: event.status,
    request: summarizeNativeProtocolPayload(event.payload),
    ...summarizeMcpAttachment(event.method, event.payload),
    ...(event.result !== undefined ? { result: summarizeNativeProtocolPayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
        }
      : {}),
  };
}

function formatAcpProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizeNativeProtocolPayload(event.payload),
  };
}

function isTransientProtocolMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const method = Reflect.get(message, "tag") ?? Reflect.get(message, "method");
  if (method !== "session/update") return false;

  const payload = Reflect.get(message, "payload") ?? Reflect.get(message, "params");
  if (typeof payload !== "object" || payload === null) return false;
  const update = Reflect.get(payload, "update");
  if (typeof update !== "object" || update === null) return false;
  const updateType = Reflect.get(update, "sessionUpdate");
  return typeof updateType === "string" && transientProtocolUpdates.has(updateType);
}

function rawChunkContainsOnlyTransientMessages(payload: string): boolean {
  const lines = payload.split("\n");
  const remainder = lines.pop() ?? "";
  if (remainder.trim().length > 0) return false;

  const messages: Array<unknown> = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      return false;
    }
  }
  return messages.length > 0 && messages.every(isTransientProtocolMessage);
}

function filterTransientProtocolLog(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): EffectAcpProtocol.AcpProtocolLogEvent | undefined {
  if (event.direction !== "incoming") return event;

  if (event.stage === "raw" && typeof event.payload === "string") {
    return rawChunkContainsOnlyTransientMessages(event.payload) ? undefined : event;
  }

  if (event.stage !== "decoded") return event;
  if (!Array.isArray(event.payload)) {
    return isTransientProtocolMessage(event.payload) ? undefined : event;
  }

  const payload = event.payload.filter((message) => !isTransientProtocolMessage(message));
  return payload.length === 0 ? undefined : { ...event, payload };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
    readonly verboseProtocolLogging?: boolean;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = (logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4(),
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger && input.verboseProtocolLogging
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) => {
                const filtered = filterTransientProtocolLog(event);
                return filtered
                  ? writeNativeAcpLog({
                      kind: "protocol",
                      payload: formatAcpProtocolLogPayload(filtered),
                    })
                  : Effect.void;
              },
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
