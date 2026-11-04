/**
 * ViewCode: why a pending question's options are locked, shown on the card so a greyed-out
 * question is never silent. Null while the user can answer. The ended-question case comes first
 * because the composer also reports it as "responding".
 */
export function pendingUserInputLockReason(input: {
  readonly canRespond: boolean;
  readonly disabled: boolean;
  readonly isResponding: boolean;
}): string | null {
  if (!input.canRespond) return "This question can no longer be answered.";
  if (input.disabled) return "You can't answer questions from this connection.";
  if (input.isResponding) return "Sending your answer…";
  return null;
}
