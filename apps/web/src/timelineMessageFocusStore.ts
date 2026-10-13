import { create } from "zustand";

/**
 * A request to bring one message of a chat into view, from outside its timeline (the Review
 * panel's "Sent to …" link). The timeline of that chat answers it once the message is there, so a
 * request made while the message is still queued waits for it to go out.
 */
export interface TimelineMessageFocusRequest {
  readonly threadKey: string;
  readonly messageId: string;
  readonly nonce: number;
}

interface TimelineMessageFocusState {
  readonly request: TimelineMessageFocusRequest | null;
  readonly focus: (threadKey: string, messageId: string) => void;
  /** Called by the timeline once it scrolled to the message. */
  readonly settle: (nonce: number) => void;
}

export const useTimelineMessageFocusStore = create<TimelineMessageFocusState>()((set) => ({
  request: null,
  focus: (threadKey, messageId) =>
    set((state) => ({
      request: { threadKey, messageId, nonce: (state.request?.nonce ?? 0) + 1 },
    })),
  settle: (nonce) => set((state) => (state.request?.nonce === nonce ? { request: null } : state)),
}));
