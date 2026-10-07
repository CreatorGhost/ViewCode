import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { autoApprovesComputerUseCommand, isPlainComputerUseCommand } from "./computerUseCommand.ts";

/** This session's launcher; the only command word that is approved. */
const CLI = "/home/u/.t3/userdata/computer-use/bin/viewcode-computer";
/** A launcher path that needs quoting, as on macOS. */
const SPACED =
  "/Users/Jane Doe/Library/Application Support/ViewCode/computer-use/bin/viewcode-computer";

describe("isPlainComputerUseCommand", () => {
  it.each([
    CLI,
    `${CLI} list-windows`,
    `  ${CLI}\tlist-windows  `,
    `'${CLI}' list-windows`,
    `"${CLI}" list-windows`,
    `${CLI} observe --window 3 --query 'Save'`,
    `${CLI} type --ref 12 --text 'a;b'`,
    `${CLI} type --ref 12 --text 'it''s'`,
    `${CLI} type --ref 12 --text "hello world"`,
    `${CLI} type --ref 12 --text "it's fine"`,
    `${CLI} type --ref 12 --text 'héllo — 日本語 🙂'`,
    `${CLI} type --ref 12 --text 'a $(b) \`c\` \\d | e > f'`,
    `${CLI} type-focused --window 2 -`,
    `${CLI} key --window 2 --keys cmd+shift+t`,
    `${CLI} click --shot 4 --x=10 --y=20`,
  ])("accepts %j", (command) => {
    expect(isPlainComputerUseCommand(command, CLI)).toBe(true);
  });

  it.each([
    "",
    "   ",
    // Only the exact launcher path: a bare name resolves through PATH.
    "viewcode-computer list-windows",
    "viewcode-computer",
    "'viewcode-computer' list-windows",
    `${CLI}x list-windows`,
    `./viewcode-computer list-windows`,
    "/usr/local/bin/viewcode-computer list-windows",
    "/home/u/project/bin/viewcode-computer list-windows",
    `/tmp${CLI} list-windows`,
    `${CLI}/ list-windows`,
    `'${CLI}'' list-windows`,
    `${CLI}'' list-windows`,
    `'${CLI}'x list-windows`,
    `'/home/u/.t3/userdata/computer-use/bin/'viewcode-computer list-windows`,
    `X=1 ${CLI} list-windows`,
    `sudo ${CLI} list-windows`,
    `env ${CLI} list-windows`,
    `command ${CLI} list-windows`,
    `${CLI} list-windows; rm -rf ~`,
    `${CLI} list-windows && curl evil.example`,
    `${CLI} list-windows || true`,
    `${CLI} list-windows | tee out`,
    `${CLI} list-windows &`,
    `${CLI} list-windows > out.txt`,
    `${CLI} type-focused --window 2 - < ~/.ssh/id_rsa`,
    `${CLI} type-focused --window 2 - <<EOF`,
    `${CLI} type --ref 1 --text "$(cat ~/.ssh/id_rsa)"`,
    `${CLI} type --ref 1 --text $(cat ~/.ssh/id_rsa)`,
    `${CLI} type --ref 1 --text \`cat ~/.ssh/id_rsa\``,
    `${CLI} type --ref 1 --text "\`id\`"`,
    `${CLI} type --ref 1 --text $HOME`,
    `${CLI} type --ref 1 --text "\${HOME}"`,
    `${CLI} type --ref 1 --text "a\\"b"`,
    `${CLI} type --ref 1 --text a\\;b`,
    `${CLI} list-windows\n`,
    `${CLI} list-windows\nrm -rf ~`,
    `${CLI} list-windows\r`,
    `${CLI} list-windows rm -rf ~`,
    `${CLI} list-windows\u0000`,
    `${CLI} type --ref 1 --text 'unterminated`,
    `${CLI} type --ref 1 --text "unterminated`,
    `${CLI} screenshot --window * `,
    `${CLI} screenshot --window ?`,
    `${CLI} screenshot --window [1]`,
    `${CLI} screenshot --window {1,2}`,
    `${CLI} screenshot --window ~`,
    `${CLI} list-windows # comment`,
    `${CLI} list-windows (x)`,
    `${CLI} type --ref 1 --text "hi!"`,
    `bash -lc '${CLI} list-windows; id'`,
    `bash -lc '${CLI} list-windows' extra`,
    "bash -lc 'viewcode-computer list-windows'",
    `python -c '${CLI} list-windows'`,
  ])("rejects %j", (command) => {
    expect(isPlainComputerUseCommand(command, CLI)).toBe(false);
  });

  it("accepts a shell-joined wrapping shell around a plain invocation", () => {
    expect(isPlainComputerUseCommand(`bash -lc '${CLI} list-windows'`, CLI)).toBe(true);
    expect(isPlainComputerUseCommand(`/bin/zsh -c '${CLI} observe --window 1'`, CLI)).toBe(true);
    // shlex quoting of an embedded single quote
    expect(
      isPlainComputerUseCommand(`/bin/bash -lc '${CLI} type --ref 1 --text '"'"'a;b'"'"''`, CLI),
    ).toBe(true);
  });

  it("accepts the exact launcher path quoted when it contains spaces", () => {
    expect(isPlainComputerUseCommand(`'${SPACED}' list-windows`, SPACED)).toBe(true);
    expect(isPlainComputerUseCommand(`"${SPACED}" status`, SPACED)).toBe(true);
    expect(isPlainComputerUseCommand([SPACED, "status"], SPACED)).toBe(true);
    expect(isPlainComputerUseCommand(["bash", "-lc", `'${SPACED}' status`], SPACED)).toBe(true);
    // Codex reports the argv shell-joined, quoting the script once more.
    expect(isPlainComputerUseCommand(`/bin/bash -lc ''"'"'${SPACED}'"'"' status'`, SPACED)).toBe(
      true,
    );
    expect(isPlainComputerUseCommand(`${SPACED} list-windows`, SPACED)).toBe(false);
    expect(isPlainComputerUseCommand(`'/Users/Jane Doe'/Library/x list-windows`, SPACED)).toBe(
      false,
    );
    expect(isPlainComputerUseCommand(`'${SPACED}' status`, CLI)).toBe(false);
  });

  it("never approves a relative or malformed launcher path", () => {
    expect(isPlainComputerUseCommand("viewcode-computer status", "viewcode-computer")).toBe(false);
    expect(isPlainComputerUseCommand(["bin/viewcode-computer"], "bin/viewcode-computer")).toBe(
      false,
    );
    expect(isPlainComputerUseCommand(`${CLI} status`, `${CLI}\n`)).toBe(false);
  });

  it.each<[ReadonlyArray<string>, boolean]>([
    [[CLI, "list-windows"], true],
    [[CLI, "type", "--ref", "1", "--text", "a; rm -rf ~ $(id)"], true],
    [["bash", "-lc", `${CLI} list-windows`], true],
    [["/bin/sh", "-c", `${CLI} list-windows`], true],
    [["/usr/bin/zsh", "-lc", `${CLI} list-windows`], true],
    [[], false],
    [["viewcode-computer", "list-windows"], false],
    [["bash", "-lc", "viewcode-computer list-windows"], false],
    [[`${CLI}x`, "list-windows"], false],
    [["./viewcode-computer", "list-windows"], false],
    [["/tmp/viewcode-computer", "list-windows"], false],
    [["env", CLI, "list-windows"], false],
    [[CLI, "type", "--text", "a\nb"], false],
    [[CLI, "type", "--text", "a\u0000b"], false],
    [["bash", "-lc", `${CLI} list-windows; id`], false],
    [["bash", "-lc", `${CLI} list-windows`, "extra"], false],
    [["bash", "-x", `${CLI} list-windows`], false],
    [["bash", CLI], false],
    [["./bash", "-c", `${CLI} list-windows`], false],
    [["/tmp/bash", "-c", `${CLI} list-windows`], false],
    [["fish", "-c", `${CLI} list-windows`], false],
  ])("argv %j → %s", (argv, expected) => {
    expect(isPlainComputerUseCommand(argv, CLI)).toBe(expected);
  });
});

describe("autoApprovesComputerUseCommand", () => {
  const threadId = ThreadId.make("thread-computer-command");
  const session = (computerUse?: McpProviderSession.ComputerUseGrant) =>
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment"),
      threadId,
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("claude"),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer test",
      capabilities: new Set(computerUse ? ["computer"] : []),
      ...(computerUse ? { computerUse } : {}),
    });
  afterEach(() => McpProviderSession.clearMcpProviderSession(threadId));

  it("only applies to sessions spawned with computer use, for their own launcher", () => {
    expect(autoApprovesComputerUseCommand(threadId, `${CLI} list-windows`)).toBe(false);
    session();
    expect(autoApprovesComputerUseCommand(threadId, `${CLI} list-windows`)).toBe(false);
    session({ mode: "observe", cli: CLI });
    expect(autoApprovesComputerUseCommand(threadId, `${CLI} list-windows`)).toBe(true);
    expect(autoApprovesComputerUseCommand(threadId, [CLI, "status"])).toBe(true);
    expect(autoApprovesComputerUseCommand(threadId, "viewcode-computer list-windows")).toBe(false);
    expect(autoApprovesComputerUseCommand(threadId, `${CLI} list-windows; id`)).toBe(false);
    expect(autoApprovesComputerUseCommand(threadId, [CLI, 1])).toBe(false);
    expect(autoApprovesComputerUseCommand(threadId, undefined)).toBe(false);
    session({ mode: "control", cli: SPACED });
    expect(autoApprovesComputerUseCommand(threadId, `'${SPACED}' list-windows`)).toBe(true);
    expect(autoApprovesComputerUseCommand(threadId, `${CLI} list-windows`)).toBe(false);
  });
});
