// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addAccountSettingsPatch, prepareProviderAccountSignIn } from "./providerAccounts.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-accounts-"));

const withInstances = (instances: ServerSettings["providerInstances"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: instances,
});

describe("addAccountSettingsPatch", () => {
  it("adds a managed Codex account sharing the default CODEX_HOME", () => {
    const settings = withInstances({
      [ProviderInstanceId.make("codex")]: {
        driver: ProviderDriverKind.make("codex"),
        config: { homePath: "~/.codex-shared" },
      },
    });
    const { patch, result } = addAccountSettingsPatch({
      settings,
      account: {
        driver: "codex",
        instanceId: ProviderInstanceId.make("codex_work"),
        displayName: "Work",
      },
      stateDir: "/state",
      platform: "linux",
    });
    expect(result).toEqual({
      instanceId: "codex_work",
      homePath: "~/.codex-shared",
      shadowHomePath: "/state/provider-accounts/codex_work",
    });
    expect(Object.keys(patch.providerInstances)).toEqual(["codex", "codex_work"]);
    expect(patch.providerInstances[ProviderInstanceId.make("codex_work")]).toMatchObject({
      driver: "codex",
      displayName: "Work",
      enabled: true,
    });
  });

  it("references an existing Claude directory as the config dir", () => {
    const { result } = addAccountSettingsPatch({
      settings: withInstances({}),
      account: {
        driver: "claudeAgent",
        instanceId: ProviderInstanceId.make("claudeAgent_personal"),
        displayName: "Personal",
        existingDirectory: "~/.claude_personal",
      },
      stateDir: "/state",
    });
    expect(result).toEqual({ instanceId: "claudeAgent_personal", homePath: "~/.claude_personal" });
  });

  it("refuses an id that is already taken, including built-in defaults", () => {
    expect(() =>
      addAccountSettingsPatch({
        settings: withInstances({}),
        account: {
          driver: "codex",
          instanceId: ProviderInstanceId.make("codex"),
          displayName: "Codex",
        },
        stateDir: "/state",
      }),
    ).toThrow(/already exists/);
  });
});

it.layer(NodeServices.layer)("prepareProviderAccountSignIn", (it) => {
  it.effect("prepares a Codex shadow home and an empty cwd", () =>
    Effect.gen(function* () {
      const root = tempDir();
      const shared = NodePath.join(root, "codex-shared");
      const shadow = NodePath.join(root, "codex-work");
      NodeFS.mkdirSync(shared);
      NodeFS.writeFileSync(NodePath.join(shared, "config.toml"), "model = 'x'\n");
      const settings = withInstances({
        [ProviderInstanceId.make("codex_work")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { homePath: shared, shadowHomePath: shadow },
        },
      });
      const plan = yield* prepareProviderAccountSignIn({
        settings,
        instanceId: ProviderInstanceId.make("codex_work"),
        stateDir: NodePath.join(root, "state"),
      });
      expect(plan.command).toBe("codex login");
      expect(NodeFS.readdirSync(plan.cwd)).toEqual([]);
      // Shared config is linked in; auth.json is left for the login to write.
      expect(NodeFS.lstatSync(NodePath.join(shadow, "config.toml")).isSymbolicLink()).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(shadow, "auth.json"))).toBe(false);
    }),
  );

  it.effect("creates a Claude config dir and uses the configured binary", () =>
    Effect.gen(function* () {
      const root = tempDir();
      const configDir = NodePath.join(root, "claude-personal");
      const settings = withInstances({
        [ProviderInstanceId.make("claudeAgent_personal")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: { homePath: configDir, binaryPath: "/opt/my tools/claude" },
        },
      });
      const plan = yield* prepareProviderAccountSignIn({
        settings,
        instanceId: ProviderInstanceId.make("claudeAgent_personal"),
        stateDir: NodePath.join(root, "state"),
      });
      expect(plan.command).toBe("'/opt/my tools/claude' auth login");
      expect(NodeFS.statSync(configDir).isDirectory()).toBe(true);
    }),
  );

  it.effect("rejects drivers without a terminal login", () =>
    Effect.gen(function* () {
      const settings = withInstances({
        [ProviderInstanceId.make("cursor_x")]: {
          driver: ProviderDriverKind.make("cursor"),
          enabled: true,
        },
      });
      const error = yield* Effect.flip(
        prepareProviderAccountSignIn({
          settings,
          instanceId: ProviderInstanceId.make("cursor_x"),
          stateDir: tempDir(),
        }),
      );
      expect(error.detail).toMatch(/Codex and Claude/);
    }),
  );
});
