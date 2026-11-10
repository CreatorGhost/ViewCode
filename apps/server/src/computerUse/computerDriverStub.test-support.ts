/**
 * Prepended to a stub helper script in tests. The real helper speaks JSON
 * lines on stdio; this lets a stub be written with `process.on("message")`
 * and `process.send`, and still be driven over that same stdio transport.
 */
export const STDIO_STUB_SHIM = `
const __lines = require("node:readline").createInterface({ input: process.stdin });
process.send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
__lines.on("line", (line) => process.emit("message", JSON.parse(line)));
__lines.on("close", () => process.emit("disconnect"));
`;
