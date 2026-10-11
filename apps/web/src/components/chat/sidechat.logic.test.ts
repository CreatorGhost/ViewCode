import { describe, expect, it } from "vite-plus/test";

import { isPinnedToBottom } from "./sidechat.logic";

describe("isPinnedToBottom", () => {
  it("is true only within a few pixels of the bottom edge", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 590 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 300 })).toBe(false);
  });
});
