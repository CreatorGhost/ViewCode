import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { withViewCodeTurnGuidance } from "../ViewCodeTurnGuidance.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Upstream recordings predate ViewCode's explicit per-turn cleared/off context. */
export function materializeViewCodeReplayGuidance(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: string; readonly model: string },
): ProviderReplayTranscript {
  const { driver } = runtime;
  const guide = (text: string) =>
    withViewCodeTurnGuidance(
      {
        appThread: {},
        message: { text },
        appContext: [] as ReadonlyArray<{ readonly key: string; readonly text: string }>,
      },
      { driver, playbookPath: null, computerUseText: null },
    );
  const guidance = guide("");
  const prependPlain = (text: string) =>
    text === guidance.message.text || text.startsWith(`${guidance.message.text}\n\n`)
      ? text
      : text === "<any>"
        ? text
        : guide(text).message.text;
  const prepend = (text: string) => {
    const marker = "<user_request>\n";
    const start = text.lastIndexOf(marker);
    const end = text.lastIndexOf("\n</user_request>");
    return start >= 0 && end > start
      ? `${text.slice(0, start + marker.length)}${prependPlain(text.slice(start + marker.length, end))}${text.slice(end)}`
      : prependPlain(text);
  };
  const textParts = (parts: ReadonlyArray<unknown>, skipRuntime = false) => {
    let applied = false;
    return parts.map((part: unknown) => {
      if (
        applied ||
        !isRecord(part) ||
        part.type !== "text" ||
        typeof part.text !== "string" ||
        (skipRuntime && part.text.startsWith("<runtime_info>"))
      )
        return part;
      applied = true;
      return { ...part, text: prepend(part.text) };
    });
  };

  let piPrompts = 0;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) return entry;
      const frame = entry.frame;
      // Active steering does not start another turn or refresh its existing context.
      if (
        driver === "pi" &&
        frame.type === "prompt" &&
        transcript.scenario === "message_steering" &&
        ++piPrompts > 1
      )
        return entry;
      if (driver === "codex" && frame.method === "turn/start" && isRecord(frame.params)) {
        return {
          ...entry,
          frame: {
            ...frame,
            params: {
              ...frame.params,
              additionalContext: {
                ...(isRecord(frame.params.additionalContext) ? frame.params.additionalContext : {}),
                ...Object.fromEntries(
                  guidance.appContext.map(({ key, text }) => [
                    key,
                    { kind: "untrusted", value: text },
                  ]),
                ),
              },
            },
          },
        };
      }
      if (
        ((driver === "cursor" && frame.type === "run.start") ||
          (driver === "pi" && frame.type === "prompt")) &&
        typeof frame.message === "string"
      ) {
        return {
          ...entry,
          frame: {
            ...frame,
            // This fixture starts as $review; Cursor rewrites it to /review after guidance.
            message:
              driver === "cursor" && transcript.scenario === "skill_invocation"
                ? `${frame.message}\n\n${guidance.message.text}`
                : prepend(frame.message),
          },
        };
      }
      if (
        (driver === "grok" || driver === "acpRegistry") &&
        frame.method === "session/prompt" &&
        isRecord(frame.params) &&
        Array.isArray(frame.params.prompt)
      ) {
        return {
          ...entry,
          frame: { ...frame, params: { ...frame.params, prompt: textParts(frame.params.prompt) } },
        };
      }
      if (
        driver === "opencode" &&
        (frame.type === "session.promptAsync" || frame.type === "session.prompt") &&
        isRecord(frame.input)
      ) {
        return {
          ...entry,
          frame: {
            ...frame,
            input: {
              ...frame.input,
              ...(typeof frame.input.text === "string" ? { text: prepend(frame.input.text) } : {}),
              ...(Array.isArray(frame.input.parts) ? { parts: textParts(frame.input.parts) } : {}),
            },
          },
        };
      }
      if (
        driver === "muse" &&
        frame.method === "turn/start" &&
        isRecord(frame.params) &&
        Array.isArray(frame.params.input)
      ) {
        const params = frame.params;
        const parts = textParts(frame.params.input, true).map((part) =>
          isRecord(part) &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.startsWith("<runtime_info>")
            ? {
                ...part,
                text: buildRuntimeInstructions({
                  harness: "Muse Code",
                  model: runtime.model,
                  reasoningEffort:
                    typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
                }),
              }
            : part,
        );
        return {
          ...entry,
          frame: {
            ...frame,
            params: {
              ...params,
              input: parts,
              ...(typeof params.displayText === "string"
                ? { displayText: prepend(params.displayText) }
                : {}),
            },
          },
        };
      }
      if (
        driver !== "claudeAgent" ||
        frame.type !== "prompt.offer" ||
        !isRecord(frame.message) ||
        !isRecord(frame.message.message) ||
        frame.message.priority === "now"
      )
        return entry;
      const message = frame.message.message;
      const content = message.content;
      if (typeof content === "string") {
        return {
          ...entry,
          frame: {
            ...frame,
            message: { ...frame.message, message: { ...message, content: prepend(content) } },
          },
        };
      }
      if (!Array.isArray(content)) return entry;
      let applied = false;
      const parts: ReadonlyArray<unknown> = content.map((part: unknown) => {
        if (applied || !isRecord(part) || part.type !== "text" || typeof part.text !== "string")
          return part;
        applied = true;
        return { ...part, text: prepend(part.text) };
      });
      return {
        ...entry,
        frame: {
          ...frame,
          message: {
            ...frame.message,
            message: {
              ...message,
              content: applied ? parts : [{ type: "text", text: guidance.message.text }, ...parts],
            },
          },
        },
      };
    }),
  };
}
