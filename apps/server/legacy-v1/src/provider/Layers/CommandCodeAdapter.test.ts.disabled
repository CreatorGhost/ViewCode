import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type ProviderRuntimeEvent, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { CommandCodeDriver } from "../Drivers/CommandCodeDriver.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-command-code-adapter-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// A stand-in `cmd` that prints the print-mode wire format and logs its argv.
const FAKE_CMD = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CMD_LOG, JSON.stringify(args) + "\\n");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const resume = args.indexOf("--resume");
  const sessionId = resume >= 0 ? args[resume + 1] : "sess-fake-1";
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "event", event: { type: "run_start", sessionId } });
  out({ type: "event", event: { type: "text_delta", delta: "echo: " + input.split("\\n")[0] } });
  if (input.startsWith("hang")) {
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: "event", event: { type: "message_end", content: [] } });
  out({
    type: "result",
    subtype: "success",
    sessionId,
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1,
    finalText: "done",
  });
});
`;

// The shebang stub cannot run as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(testLayer)("CommandCodeAdapter", (it) => {
  it.effect.skipIf(windowsHost)("runs one process per turn and resumes the reported session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-" });
      const binaryPath = path.join(tempDir, "cmd");
      const argvLog = path.join(tempDir, "argv.ndjson");
      yield* fs.writeFileString(binaryPath, FAKE_CMD);
      yield* fs.chmod(binaryPath, 0o755);

      const instanceId = ProviderInstanceId.make("commandCode");
      const adapter = yield* makeCommandCodeAdapter(
        { ...CommandCodeDriver.defaultConfig(), enabled: true, binaryPath },
        { instanceId, environment: { ...process.env, FAKE_CMD_LOG: argvLog } },
      );
      const completed = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const seen: Array<ProviderRuntimeEvent> = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            seen.push(event);
            if (event.type === "turn.completed") yield* Queue.offer(completed, event);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );

      const threadId = ThreadId.make("thread-command-code");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        cwd: tempDir,
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "hello there" });
      expect(first.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "sess-fake-1" });
      const firstDone = yield* Queue.take(completed);
      expect(firstDone.type === "turn.completed" && firstDone.payload.state).toBe("completed");

      yield* adapter.sendTurn({
        threadId,
        input: "again",
        modelSelection: { instanceId, model: "claude-sonnet-5" },
      });
      yield* Queue.take(completed);

      const argv = (yield* fs.readFileString(argvLog))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Array<string>);
      expect(argv[0]).toContain("--yolo");
      expect(argv[0]).not.toContain("--resume");
      expect(argv[1]).toEqual(
        expect.arrayContaining(["--resume", "sess-fake-1", "--model", "claude-sonnet-5"]),
      );
      const deltas = seen.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      expect(deltas).toEqual(["echo: hello there", "echo: again"]);
      expect(seen.find((event) => event.type === "thread.started")).toMatchObject({
        payload: { providerThreadId: "sess-fake-1" },
      });

      // Stop kills the running process and settles the turn as aborted.
      const aborted = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.aborted"),
        Stream.runForEach((event) => Deferred.succeed(aborted, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* adapter.sendTurn({ threadId, input: "hang please" });
      yield* adapter.interruptTurn(threadId);
      expect((yield* Deferred.await(aborted)).type).toBe("turn.aborted");

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
