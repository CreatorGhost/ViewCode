// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// ViewCode keeps chats the user started separately apart (peerExchange.ts): a message waits for
// the user, one reply goes through, and nothing else reaches across. The rule lives in upstream's
// access wrapper and handlers, so a merge taking upstream's copy would reopen the channel with no
// type error. Behaviour is covered by OrchestratorMcpService.viewcode.test.ts and the cases in
// McpToolAccess.test.ts; this keeps the wiring.
describe("ViewCode separate-chat boundary", () => {
  it("refuses cross-chat writes and leaves sends and sidebar filing to their own rules", () => {
    const access = read("McpToolAccess.ts");
    expect(access).toContain('threadWrites(writingCaller, "refuse")');
    expect(access).toContain('threadWrites(sendingCaller, "pass")');
    expect(access).toContain("isSeparateChat(caller.threads, caller.caller, target)");
    expect(access).toContain("export const writesThreadMetadata");
  });

  it("asks the user before a send or a read reaches a separate chat", () => {
    const service = read("OrchestratorMcpService.ts");
    expect(service).toContain("yield* peerMessageText(parent, target, messageId, input.message)");
    expect(service).toContain("yield* allowPeerRead(parent, target.thread)");
  });

  it("never lets an agent answer a separate chat's question", () => {
    const thread = read("toolkits/thread/handlers.ts");
    expect(thread).toContain("only the user answers its questions");
    expect(thread).toContain("t3_thread_organize: McpToolAccess.writesThreadMetadata(");
    expect(read("toolkits/orchestrator/handlers.ts")).toContain(
      "t3_thread_update: McpToolAccess.writesThreadMetadata(",
    );
  });
});
