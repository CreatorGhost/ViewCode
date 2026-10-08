// @effect-diagnostics nodeBuiltinImport:off - exercises the plain Node helper protocol.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeMacBackgroundInput } from "./MacBackgroundInput.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const helper = (answer: unknown) => {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (data: Buffer) => {
    const request = JSON.parse(data.toString()) as { id: number };
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: answer }) + "\n");
  });
  vi.mocked(NodeChildProcess.spawn).mockReturnValue(
    child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams,
  );
  return child;
};

describe("macOS foreground application read", () => {
  it("reads and reuses the helper without posting input", async () => {
    helper(42);
    const backend = makeMacBackgroundInput();
    try {
      expect(await backend.foregroundPid()).toBe(42);
      expect(await backend.foregroundPid()).toBe(42);
      expect(NodeChildProcess.spawn).toHaveBeenCalledTimes(1);
    } finally {
      backend.close();
    }
  });

  it.each([null, "42", 0, -1, 1.5])("refuses an invalid foreground PID %s", async (pid) => {
    helper(pid);
    const backend = makeMacBackgroundInput();
    try {
      await expect(backend.foregroundPid()).rejects.toThrow("front application could not be read");
    } finally {
      backend.close();
    }
  });
});
