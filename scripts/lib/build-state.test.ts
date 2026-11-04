// @effect-diagnostics nodeBuiltinImport:off - Build safety tests use isolated directories and child-owned SQLite files.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { assertBuildStateIdle, resolveBuildState } from "./build-state.ts";

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-build-state-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("build state paths", () => {
  it("uses repo env-file home and local/process precedence for managed web settings", async () => {
    const repoRoot = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    NodeFS.mkdirSync(NodePath.join(repoRoot, ".git"));
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "T3CODE_HOME=from-root\n");
    const resolve = (baseEnv = {}) =>
      resolveBuildState({ mode: "web", repoRoot, homeDirectory, baseEnv });
    expect((await resolve()).stateDir).toBe(NodePath.join(repoRoot, "from-root/userdata"));
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.local"), "T3CODE_HOME=from-local\n");
    expect((await resolve()).stateDir).toBe(NodePath.join(repoRoot, "from-local/userdata"));
    expect((await resolve({ T3CODE_HOME: "from-shell" })).stateDir).toBe(
      NodePath.join(repoRoot, "from-shell/userdata"),
    );
  });

  it("keeps linked worktrees isolated from shell and repo env homes", async () => {
    const repoRoot = temporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".git"),
      "gitdir: /other/checkout/.git/worktrees/fixture\n",
    );
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "T3CODE_HOME=/unused-env-home\n");
    const paths = await resolveBuildState({
      mode: "web",
      repoRoot,
      baseEnv: { T3CODE_HOME: "/unused-shell-home" },
    });
    expect(paths.stateDir).toBe(NodePath.join(repoRoot, ".t3/userdata"));
  });

  it("uses the dev default for web but ignores repo env files for the desktop launcher", async () => {
    const repoRoot = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    const input = { repoRoot, homeDirectory, baseEnv: {}, platform: "darwin" as const };
    expect((await resolveBuildState({ ...input, mode: "web" })).stateDir).toBe(
      NodePath.join(homeDirectory, ".viewcode/dev"),
    );
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "T3CODE_HOME=/web-only-home\n");
    expect(await resolveBuildState({ ...input, mode: "desktop" })).toEqual({
      baseDir: NodePath.join(homeDirectory, ".viewcode"),
      stateDir: NodePath.join(homeDirectory, ".viewcode/userdata"),
      profileDir: NodePath.join(homeDirectory, "Library/Application Support/viewcode"),
    });
  });
});

describe("fresh reset guard", () => {
  it.each(["data", "profile", "symlink", "nested-link"])(
    "refuses a reported open %s file after resolving the requested directory",
    (kind) => {
      const data = temporaryDirectory();
      const profile = temporaryDirectory();
      const elsewhere = temporaryDirectory();
      const target =
        kind === "profile" ? profile : kind === "nested-link" ? temporaryDirectory() : data;
      const database = NodePath.join(target, "state.sqlite");
      NodeFS.writeFileSync(database, "fixture");
      const alias = NodePath.join(elsewhere, "home-alias");
      NodeFS.symlinkSync(data, alias, "dir");
      if (kind === "nested-link")
        NodeFS.symlinkSync(target, NodePath.join(data, "linked-state"), "dir");
      const canonical = NodeFS.realpathSync(kind === "symlink" ? alias : target);
      const scanRoot = kind === "nested-link" ? NodeFS.realpathSync(data) : canonical;
      const scanned: string[] = [];
      expect(() =>
        assertBuildStateIdle([kind === "symlink" ? alias : data, profile], (command, args) => {
          expect(command).toBe("lsof");
          const directory = args.at(-1)!;
          expect(args).toEqual(["-x", "-nP", "-Fpn", "+D", directory]);
          scanned.push(directory);
          return {
            status: directory === scanRoot ? 0 : 1,
            stdout: directory === scanRoot ? `p42\nn${NodeFS.realpathSync(database)}\n` : "",
            stderr: "",
            signal: null,
          };
        }),
      ).toThrow("Files are still open");
      expect(scanned).toContain(scanRoot);
      expect(NodeFS.existsSync(database)).toBe(true);
    },
  );

  it.each(["data", "profile", "symlink", "nested-link"])(
    "protects an open %s database with the native scanner, including incomplete host scans",
    async (kind) => {
      const data = temporaryDirectory();
      const profile = temporaryDirectory();
      const elsewhere = temporaryDirectory();
      const target =
        kind === "profile" ? profile : kind === "nested-link" ? temporaryDirectory() : data;
      const database = NodePath.join(target, "nested/state.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(database));
      const alias = NodePath.join(elsewhere, "home-alias");
      NodeFS.symlinkSync(data, alias, "dir");
      if (kind === "nested-link")
        NodeFS.symlinkSync(target, NodePath.join(data, "linked-state"), "dir");
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { DatabaseSync } from 'node:sqlite';
      process.title = 'node-web-fixture';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('CREATE TABLE fixture (value TEXT)');
      process.stdin.resume();
      process.stdin.on('end', () => database.close());
      process.stdout.write('ready');
    `,
          database,
        ],
        { cwd: elsewhere, stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      const inspectState = (paths: string[]) => {
        let incomplete = false;
        let failure: unknown;
        try {
          assertBuildStateIdle(paths, (command, args, options) => {
            const result = NodeChildProcess.spawnSync(command, args, options);
            incomplete ||= Boolean(
              result.error ||
              result.signal ||
              result.stderr ||
              ![0, 1].includes(result.status ?? -1),
            );
            return result;
          });
        } catch (error) {
          failure = error;
        }
        return { incomplete, failure };
      };
      try {
        await NodeEvents.EventEmitter.once(child.stdout, "data");
        const inspection = inspectState([kind === "symlink" ? alias : data, profile]);
        // macOS can report inaccessible mounts unrelated to the fixture. The
        // production guard must refuse those scans, not hide their diagnostics.
        expect(inspection.failure).toBeInstanceOf(Error);
        expect((inspection.failure as Error).message).toContain(
          inspection.incomplete ? "Cannot check open files" : "Files are still open",
        );
        expect(NodeFS.existsSync(database)).toBe(true);
      } finally {
        child.stdin.end();
        await exited;
      }
      const inspection = inspectState([data, profile]);
      if (inspection.incomplete) {
        expect(inspection.failure).toBeInstanceOf(Error);
        expect((inspection.failure as Error).message).toContain("Cannot check open files");
      } else {
        expect(inspection.failure).toBeUndefined();
      }
      expect(NodeFS.existsSync(database)).toBe(true);
    },
  );

  it.each([
    { status: null, error: new Error("lsof unavailable"), stderr: "" },
    { status: 1, stderr: "lsof: permission denied" },
    { status: 2, stderr: "" },
    { status: null, error: new Error("timed out"), stderr: "" },
  ])("fails closed when open-file inspection is incomplete: $status $stderr", (result) => {
    expect(() =>
      assertBuildStateIdle([temporaryDirectory()], () => ({ ...result, stdout: "", signal: null })),
    ).toThrow("Cannot check open files");
  });

  it("accepts lsof's quiet no-match exit and ignores only nonexistent targets", () => {
    const directory = temporaryDirectory();
    expect(() =>
      assertBuildStateIdle([directory, NodePath.join(directory, "absent")], () => ({
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
      })),
    ).not.toThrow();
  });
});
