import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { autoApprovesComputerUseCommand, isPlainComputerUseCommand } from "./computerUseCommand.ts";

describe("isPlainComputerUseCommand", () => {
  it.each([
    "viewcode-computer",
    "viewcode-computer list-windows",
    "  viewcode-computer\tlist-windows  ",
    "viewcode-computer observe --window 3 --query 'Save'",
    "viewcode-computer type --ref 12 --text 'a;b'",
    "viewcode-computer type --ref 12 --text 'it''s'",
    'viewcode-computer type --ref 12 --text "hello world"',
    'viewcode-computer type --ref 12 --text "it\'s fine"',
    "viewcode-computer type --ref 12 --text 'héllo — 日本語 🙂'",
    "viewcode-computer type --ref 12 --text 'a $(b) `c` \\d | e > f'",
    "viewcode-computer type-focused --window 2 -",
    "viewcode-computer key --window 2 --keys cmd+shift+t",
    "viewcode-computer click --shot 4 --x=10 --y=20",
  ])("accepts %j", (command) => {
    expect(isPlainComputerUseCommand(command)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "viewcode-computerx list-windows",
    "./viewcode-computer list-windows",
    "/usr/local/bin/viewcode-computer list-windows",
    "'viewcode-computer' list-windows",
    '"viewcode-computer" list-windows',
    "viewcode-computer'' list-windows",
    "X=1 viewcode-computer list-windows",
    "sudo viewcode-computer list-windows",
    "env viewcode-computer list-windows",
    "command viewcode-computer list-windows",
    "viewcode-computer list-windows; rm -rf ~",
    "viewcode-computer list-windows && curl evil.example",
    "viewcode-computer list-windows || true",
    "viewcode-computer list-windows | tee out",
    "viewcode-computer list-windows &",
    "viewcode-computer list-windows > out.txt",
    "viewcode-computer type-focused --window 2 - < ~/.ssh/id_rsa",
    "viewcode-computer type-focused --window 2 - <<EOF",
    'viewcode-computer type --ref 1 --text "$(cat ~/.ssh/id_rsa)"',
    "viewcode-computer type --ref 1 --text $(cat ~/.ssh/id_rsa)",
    "viewcode-computer type --ref 1 --text `cat ~/.ssh/id_rsa`",
    'viewcode-computer type --ref 1 --text "`id`"',
    "viewcode-computer type --ref 1 --text $HOME",
    'viewcode-computer type --ref 1 --text "${HOME}"',
    'viewcode-computer type --ref 1 --text "a\\"b"',
    "viewcode-computer type --ref 1 --text a\\;b",
    "viewcode-computer list-windows\n",
    "viewcode-computer list-windows\nrm -rf ~",
    "viewcode-computer list-windows\r",
    "viewcode-computer list-windows rm -rf ~",
    "viewcode-computer list-windows\u0000",
    "viewcode-computer type --ref 1 --text 'unterminated",
    'viewcode-computer type --ref 1 --text "unterminated',
    "viewcode-computer screenshot --window * ",
    "viewcode-computer screenshot --window ?",
    "viewcode-computer screenshot --window [1]",
    "viewcode-computer screenshot --window {1,2}",
    "viewcode-computer screenshot --window ~",
    "viewcode-computer list-windows # comment",
    "viewcode-computer list-windows (x)",
    'viewcode-computer type --ref 1 --text "hi!"',
    "bash -lc 'viewcode-computer list-windows; id'",
    "bash -lc 'viewcode-computer list-windows' extra",
    "python -c 'viewcode-computer list-windows'",
  ])("rejects %j", (command) => {
    expect(isPlainComputerUseCommand(command)).toBe(false);
  });

  it("accepts a shell-joined wrapping shell around a plain invocation", () => {
    expect(isPlainComputerUseCommand("bash -lc 'viewcode-computer list-windows'")).toBe(true);
    expect(isPlainComputerUseCommand("/bin/zsh -c 'viewcode-computer observe --window 1'")).toBe(
      true,
    );
    // shlex quoting of an embedded single quote
    expect(
      isPlainComputerUseCommand(
        `/bin/bash -lc 'viewcode-computer type --ref 1 --text '"'"'a;b'"'"''`,
      ),
    ).toBe(true);
  });

  it.each<[ReadonlyArray<string>, boolean]>([
    [["viewcode-computer", "list-windows"], true],
    [["viewcode-computer", "type", "--ref", "1", "--text", "a; rm -rf ~ $(id)"], true],
    [["bash", "-lc", "viewcode-computer list-windows"], true],
    [["/bin/sh", "-c", "viewcode-computer list-windows"], true],
    [["/usr/bin/zsh", "-lc", "viewcode-computer list-windows"], true],
    [[], false],
    [["viewcode-computerx", "list-windows"], false],
    [["./viewcode-computer", "list-windows"], false],
    [["/tmp/viewcode-computer", "list-windows"], false],
    [["env", "viewcode-computer", "list-windows"], false],
    [["viewcode-computer", "type", "--text", "a\nb"], false],
    [["viewcode-computer", "type", "--text", "a\u0000b"], false],
    [["bash", "-lc", "viewcode-computer list-windows; id"], false],
    [["bash", "-lc", "viewcode-computer list-windows", "extra"], false],
    [["bash", "-x", "viewcode-computer list-windows"], false],
    [["bash", "viewcode-computer"], false],
    [["./bash", "-c", "viewcode-computer list-windows"], false],
    [["/tmp/bash", "-c", "viewcode-computer list-windows"], false],
    [["fish", "-c", "viewcode-computer list-windows"], false],
  ])("argv %j → %s", (argv, expected) => {
    expect(isPlainComputerUseCommand(argv)).toBe(expected);
  });
});

describe("autoApprovesComputerUseCommand", () => {
  const threadId = ThreadId.make("thread-computer-command");
  const session = (computerUseMode?: "observe" | "control") =>
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment"),
      threadId,
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("claude"),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer test",
      capabilities: new Set(computerUseMode ? ["computer"] : []),
      ...(computerUseMode ? { computerUseMode } : {}),
    });
  afterEach(() => McpProviderSession.clearMcpProviderSession(threadId));

  it("only applies to sessions spawned with computer use", () => {
    expect(autoApprovesComputerUseCommand(threadId, "viewcode-computer list-windows")).toBe(false);
    session();
    expect(autoApprovesComputerUseCommand(threadId, "viewcode-computer list-windows")).toBe(false);
    session("observe");
    expect(autoApprovesComputerUseCommand(threadId, "viewcode-computer list-windows")).toBe(true);
    expect(autoApprovesComputerUseCommand(threadId, ["viewcode-computer", "status"])).toBe(true);
    expect(autoApprovesComputerUseCommand(threadId, "viewcode-computer list-windows; id")).toBe(
      false,
    );
    expect(autoApprovesComputerUseCommand(threadId, ["viewcode-computer", 1])).toBe(false);
    expect(autoApprovesComputerUseCommand(threadId, undefined)).toBe(false);
  });
});
