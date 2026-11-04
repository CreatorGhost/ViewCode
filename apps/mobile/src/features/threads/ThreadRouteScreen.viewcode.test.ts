// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// ViewCode guard (1de3df16d): which messages the agent never received is decided by
// undeliveredRunMessages in the client runtime, with its own tests. The phone shows it only
// through upstream's thread screen and feed, which a merge can rewrite without a conflict
// or a type error (the feed's prop is optional), so this checks that wiring.
describe("Not delivered on the phone (ViewCode)", () => {
  it("reads undelivered messages from the thread and hands them to the feed", () => {
    const screen = read("ThreadRouteScreen.tsx");
    expect(screen).toContain("undeliveredRunMessages(thread.projection)");
    expect(screen).toContain("undeliveredMessages={undeliveredMessages}");
  });

  it("marks such a message in the feed", () => {
    const feed = read("ThreadFeed.tsx");
    expect(feed).toContain("props.undeliveredMessages?.has(message.id)");
    expect(feed).toContain("Not delivered. The agent may not have received this message.");
  });
});
