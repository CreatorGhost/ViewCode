import { describe, expect, it } from "vite-plus/test";

import {
  accountLoginCommand,
  deriveAccountInstanceId,
  existingDirectoryAccountConfig,
  managedAccountConfig,
  slugifyAccountLabel,
  validateAccountInstanceId,
} from "./providerAccounts.ts";

describe("deriveAccountInstanceId", () => {
  it("prefixes the driver to a slug of the label", () => {
    expect(deriveAccountInstanceId("codex", "Work")).toBe("codex_work");
    expect(deriveAccountInstanceId("claudeAgent", "  Side  Project! ")).toBe(
      "claudeAgent_side_project",
    );
  });

  it("is empty when the label has nothing usable", () => {
    expect(deriveAccountInstanceId("codex", "  !!! ")).toBe("");
  });

  it("suffixes a taken id and stays within 64 characters", () => {
    expect(deriveAccountInstanceId("codex", "Work", new Set(["codex_work"]))).toBe("codex_work_2");
    expect(deriveAccountInstanceId("codex", "Work", new Set(["codex_work", "codex_work_2"]))).toBe(
      "codex_work_3",
    );
    const long = deriveAccountInstanceId("claudeAgent", "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    const taken = deriveAccountInstanceId("claudeAgent", "x".repeat(200), new Set([long]));
    expect(taken.length).toBeLessThanOrEqual(64);
    expect(taken.endsWith("_2")).toBe(true);
  });

  it("never leaves a trailing underscore after truncation", () => {
    expect(slugifyAccountLabel(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });
});

describe("validateAccountInstanceId", () => {
  it("rejects empty, malformed and duplicate ids", () => {
    expect(validateAccountInstanceId("", new Set())).not.toBeNull();
    expect(validateAccountInstanceId("1codex", new Set())).not.toBeNull();
    expect(validateAccountInstanceId("codex_work", new Set(["codex_work"]))).not.toBeNull();
    expect(validateAccountInstanceId("codex_work", new Set())).toBeNull();
  });
});

describe("managed account homes", () => {
  it("gives Codex the shared home plus a per-account shadow home", () => {
    expect(
      managedAccountConfig({
        driver: "codex",
        instanceId: "codex_work",
        stateDir: "/srv/viewcode/userdata/",
      }),
    ).toEqual({
      homePath: "",
      shadowHomePath: "/srv/viewcode/userdata/provider-accounts/codex_work",
    });
    expect(
      managedAccountConfig({
        driver: "codex",
        instanceId: "codex_work",
        stateDir: "/s",
        sharedCodexHome: " ~/.codex-shared ",
      }).homePath,
    ).toBe("~/.codex-shared");
  });

  it("gives Claude its own config directory", () => {
    expect(
      managedAccountConfig({
        driver: "claudeAgent",
        instanceId: "claudeAgent_personal",
        stateDir: "C:\\Users\\me\\.viewcode\\userdata",
        platform: "win32",
      }),
    ).toEqual({
      homePath: "C:\\Users\\me\\.viewcode\\userdata\\provider-accounts\\claudeAgent_personal",
    });
  });

  it("uses an existing directory as the whole home", () => {
    expect(existingDirectoryAccountConfig("codex", " ~/.codex_personal ")).toEqual({
      homePath: "~/.codex_personal",
    });
  });
});

describe("accountLoginCommand", () => {
  it("builds each CLI's login command and quotes odd binaries", () => {
    expect(accountLoginCommand({ driver: "codex", binaryPath: "", platform: "posix" })).toBe(
      "codex login",
    );
    expect(
      accountLoginCommand({ driver: "claudeAgent", binaryPath: "claude", platform: "posix" }),
    ).toBe("claude auth login");
    expect(
      accountLoginCommand({
        driver: "claudeAgent",
        binaryPath: "/opt/my tools/claude",
        platform: "posix",
      }),
    ).toBe("'/opt/my tools/claude' auth login");
    expect(
      accountLoginCommand({
        driver: "codex",
        binaryPath: "C:\\Program Files\\codex.exe",
        platform: "windows",
      }),
    ).toBe("& 'C:\\Program Files\\codex.exe' login");
  });
});
