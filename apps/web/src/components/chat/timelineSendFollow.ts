/**
 * ViewCode: whether the timeline already shows a user message, so a new send is a follow-up.
 *
 * The timeline anchors only a thread's first message (`resolveChatListAnchoredEndSpace`); a
 * follow-up relies on the list following its end, which re-pins only within a viewport of it. A
 * reader left above the end by the previous anchored reply would then stay there with Scroll to end
 * hidden, so a follow-up send moves to the end first. Guarded by timelineSendFollow.viewcode.test.ts.
 */
export function timelineHasUserMessage(
  entries: ReadonlyArray<{ readonly kind: string; readonly message?: { readonly role: string } }>,
): boolean {
  return entries.some((entry) => entry.kind === "message" && entry.message?.role === "user");
}
