function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
export function projectQuestionToolInput(data: Record<string, unknown>, title: unknown) {
  const item = asRecord(data.item);
  const toolName = data.toolName ?? data.tool ?? item?.tool ?? title;
  if (typeof toolName !== "string") return {};
  const name = toolName
    .split(/__|[./]/)
    .at(-1)
    ?.replace(/[_\s]/g, "")
    .toLowerCase();
  if (!name || !/^(askuserquestion|requestuserinput(?:async)?|askquestion|question)$/.test(name))
    return {};
  const input = asRecord(
    data.input ?? data.rawInput ?? asRecord(data.state)?.input ?? item?.arguments,
  );
  const questions = input?.questions ?? asRecord(input?.params)?.questions;
  if (!Array.isArray(questions)) return {};
  // Clients match native tools to the canonical question; choices and answers
  // already live on the user-input activities and need not cross the wire twice.
  return {
    toolName,
    input: {
      questions: questions.map((value) => {
        const question = asRecord(value);
        return {
          question: asTrimmedString(
            question?.question ?? question?.question_text ?? question?.prompt ?? question?.title,
          ),
        };
      }),
    },
  };
}
