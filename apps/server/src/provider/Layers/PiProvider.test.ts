// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { PiSettings } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");
const decodePiSettings = Schema.decodeSync(PiSettings);

// `pi --version` prints FAKE_PI_VERSION; anything else is the RPC mock.
const fakePiSource = [
  'import { appendFileSync } from "node:fs";',
  'import { pathToFileURL } from "node:url";',
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") {',
  "  process.stdout.write(`${process.env.FAKE_PI_VERSION}\\n`);",
  "  process.exit(0);",
  "}",
  'appendFileSync(process.env.FAKE_PI_ARGV, args.join(" ") + "\\n");',
  `await import(pathToFileURL(${JSON.stringify(mockAgentPath)}).href);`,
  "",
].join("\n");

const probe = (env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-probe-" });
      const argvPath = NodePath.join(directory, "argv.log");
      const binaryPath = writeFakeCli({
        directory,
        name: "pi",
        source: fakePiSource,
        env: { FAKE_PI_ARGV: argvPath, ...env },
      });
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath }),
      );
      const argv = yield* fs.readFileString(argvPath).pipe(Effect.orElseSucceed(() => ""));
      return { snapshot, argv: argv.trim() };
    }),
  );

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: "/definitely/not/installed/pi" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
    }),
  );

  it.effect("lists models, commands and skills from a throwaway RPC session", () =>
    Effect.gen(function* () {
      const { snapshot, argv } = yield* probe({ FAKE_PI_VERSION: "1.2.0" });
      expect(snapshot.version).toBe("1.2.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "anthropic/claude-sonnet-5",
        "openai/gpt-6-sol",
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact", "review"]);
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(["release"]);
      // No session file is written and no MCP server starts for a health check.
      expect(argv).toBe("--mode rpc --no-session --offline --no-mcp");
    }),
  );

  it.effect("leaves out --no-mcp for a Pi that predates it", () =>
    Effect.gen(function* () {
      const { argv } = yield* probe({ FAKE_PI_VERSION: "1.0.3" });
      expect(argv).toBe("--mode rpc --no-session --offline");
    }),
  );

  it.effect("asks for an update below the minimum version", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* probe({ FAKE_PI_VERSION: "0.98.1" });
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("0.99.0");
    }),
  );

  it.effect("warns when Pi has no usable models", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* probe({ FAKE_PI_VERSION: "1.2.0", PI_MOCK_NO_MODELS: "1" });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    }),
  );
});
