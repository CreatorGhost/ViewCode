/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * Both dispatch here before the full CLI module graph (seconds of evaluation) loads; everything
 * else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "__viewcode-review") {
    const { runReviewCliMain } = await import("./reviewCli/ReviewCli.ts");
    const args = process.argv.slice(3);
    process.exitCode = await runReviewCliMain(args[0] === "--" ? args.slice(1) : args);
  } else if (command === "__viewcode-browser") {
    const { runBrowserCliMain } = await import("./browserCli/BrowserCli.ts");
    const args = process.argv.slice(3);
    process.exitCode = await runBrowserCliMain(args[0] === "--" ? args.slice(1) : args);
  } else if (command === "__viewcode-review" || command === "__viewcode-computer") {
    const args = process.argv.slice(3);
    const forwarded = args[0] === "--" ? args.slice(1) : args;
    const run =
      command === "__viewcode-review"
        ? (await import("./reviewCli/ReviewCli.ts")).runReviewCliMain
        : (await import("./computerUse/ComputerUseCli.ts")).runComputerCliMain;
    process.exitCode = await run(forwarded);
  } else if (command === "__computer-use-driver") {
    const { runComputerUseDriverWorker } = await import("./computerUse/Xa11yDriverWorker.ts");
    await runComputerUseDriverWorker();
  } else if (command === "__mcp-stdio-bridge") {
    const { runMcpStdioBridgeMain } = await import("./mcp/McpStdioBridge.ts");
    process.exitCode = await runMcpStdioBridgeMain(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    // Before anything reads stdin: the desktop app's Windows launcher starts
    // the CLI without one. Never for the fast paths, whose stdin is a pipe.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
