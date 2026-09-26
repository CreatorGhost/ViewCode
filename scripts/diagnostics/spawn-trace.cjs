// Logs every child process a Node program starts, one synchronous line each,
// so the last line survives a SIGKILL. Diagnostic only; changes no behaviour.
//
//   NODE_OPTIONS="--require /abs/path/spawn-trace.cjs" SPAWN_TRACE_LOG=/tmp/spawn-trace.log npx t3 ...
//
// Child Node processes inherit NODE_OPTIONS, so they are traced too (the pid
// column tells them apart).
"use strict";

const fs = require("node:fs");
const childProcess = require("node:child_process");

const logPath = process.env.SPAWN_TRACE_LOG || "/tmp/spawn-trace.log";
const start = Date.now();

function write(event, detail) {
  const line = `${new Date().toISOString()} +${Date.now() - start}ms pid=${process.pid} ppid=${process.ppid} ${event} ${detail}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    // Never let tracing break the traced program.
  }
}

function describe(file, args) {
  const list = Array.isArray(args) ? args : [];
  return JSON.stringify([String(file), ...list.map(String)]).slice(0, 600);
}

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function traced(file, args, ...rest) {
    write(name, describe(file, args));
    return original.call(this, file, args, ...rest);
  };
}
for (const name of ["exec", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function traced(command, ...rest) {
    write(name, JSON.stringify(String(command)).slice(0, 600));
    return original.call(this, command, ...rest);
  };
}

write("start", describe(process.argv[0], process.argv.slice(1)));
process.on("exit", (code) => write("exit", `code=${code}`));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    write("signal", signal);
    process.exit(128);
  });
}
