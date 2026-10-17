// @effect-diagnostics nodeBuiltinImport:off - builds real files and symlinks to resolve.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  acpComputerUseAllowOnceOption,
  autoApprovesComputerUseCommand,
  isComputerUseScreenshotRead,
  isPlainComputerUseCommand,
} from "./computerUseCommand.ts";

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

type Session = Parameters<typeof autoApprovesComputerUseCommand>[0];
const session = (cli: string, shots?: string): Session => ({
  capabilities: new Set(["computer"]),
  agentDeviceEnvironment: {
    VIEWCODE_COMPUTER_CLI: cli,
    ...(shots === undefined ? {} : { VIEWCODE_COMPUTER_SCREENSHOTS_DIR: shots }),
  },
});

describe("autoApprovesComputerUseCommand", () => {
  it("requires an enabled native session and its own absolute launcher", () => {
    expect(autoApprovesComputerUseCommand(undefined, `${CLI} list-windows`)).toBe(false);
    expect(autoApprovesComputerUseCommand({ capabilities: new Set() }, `${CLI} list-windows`)).toBe(
      false,
    );
    const config = session(CLI);
    expect(autoApprovesComputerUseCommand(config, `${CLI} list-windows`)).toBe(true);
    expect(autoApprovesComputerUseCommand(config, [CLI, "status"])).toBe(true);
    expect(autoApprovesComputerUseCommand(config, "viewcode-computer list-windows")).toBe(false);
    expect(autoApprovesComputerUseCommand(config, `${CLI} list-windows; id`)).toBe(false);
    expect(autoApprovesComputerUseCommand(config, [CLI, 1])).toBe(false);
    expect(autoApprovesComputerUseCommand(config, undefined)).toBe(false);
    expect(autoApprovesComputerUseCommand(session(SPACED), `'${SPACED}' list-windows`)).toBe(true);
    expect(autoApprovesComputerUseCommand(session(SPACED), `${CLI} list-windows`)).toBe(false);
    expect(
      autoApprovesComputerUseCommand(
        session("viewcode-computer"),
        "viewcode-computer list-windows",
      ),
    ).toBe(false);
  });
});

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cu-shots-"));
  temporaryRoots.push(root);
  const shots = NodePath.join(root, "screenshots");
  NodeFS.mkdirSync(shots);
  const shot = NodePath.join(shots, "shot-1.png");
  NodeFS.writeFileSync(shot, "png");
  const secret = NodePath.join(root, "secret.txt");
  NodeFS.writeFileSync(secret, "secret");
  NodeFS.symlinkSync(secret, NodePath.join(shots, "planted.png"));
  return { config: session(CLI, shots), shots, shot, secret };
};

describe("isComputerUseScreenshotRead", () => {
  it("allows only existing files inside the native session's own screenshot directory", () => {
    const { config, shots, shot, secret } = setup();
    expect(isComputerUseScreenshotRead(config, shot)).toBe(true);
    for (const path of [
      shots,
      secret,
      `${shots}/../secret.txt`,
      NodePath.join(shots, "planted.png"),
      NodePath.join(shots, "missing.png"),
      "screenshots/shot-1.png",
    ])
      expect(isComputerUseScreenshotRead(config, path)).toBe(false);
    expect(isComputerUseScreenshotRead(undefined, shot)).toBe(false);
  });
  it("answers an ACP screenshot read only when every supplied path agrees", () => {
    const { config, shot, secret } = setup();
    const request = (
      toolCall: Parameters<typeof acpComputerUseAllowOnceOption>[1]["toolCall"],
    ) => ({
      toolCall,
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    expect(
      acpComputerUseAllowOnceOption(
        config,
        request({ kind: "read", locations: [{ path: shot }], rawInput: { path: shot } }),
      ),
    ).toBe("allow");
    expect(
      acpComputerUseAllowOnceOption(config, request({ kind: "read", rawInput: { path: shot } })),
    ).toBe("allow");
    expect(
      acpComputerUseAllowOnceOption(
        config,
        request({ kind: "read", locations: [{ path: shot }], rawInput: { path: secret } }),
      ),
    ).toBeUndefined();
    expect(
      acpComputerUseAllowOnceOption(config, request({ kind: "read", rawInput: {} })),
    ).toBeUndefined();
    expect(
      acpComputerUseAllowOnceOption(
        config,
        request({ kind: "edit", locations: [{ path: shot }], rawInput: { path: shot } }),
      ),
    ).toBeUndefined();
  });
});
