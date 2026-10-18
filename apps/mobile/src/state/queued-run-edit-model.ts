import { ChatAttachment, MessageId, OrchestrationMessageContext, RunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const QueuedRunEditSchema = Schema.Struct({
  runId: RunId,
  messageId: MessageId,
  originalText: Schema.String,
  existingAttachments: Schema.Array(ChatAttachment),
  originalAttachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  active: Schema.optional(Schema.Boolean),
});

export type QueuedRunEdit = typeof QueuedRunEditSchema.Type;
