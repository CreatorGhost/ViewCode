// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { addressInUseMessage, isAddressInUse } from "./viewcodeAddressInUse.ts";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

describe("a busy port", () => {
  it("recognizes only a listen that failed with EADDRINUSE", () => {
    const busy = { _tag: "ServeError", cause: { code: "EADDRINUSE" } };
    expect(isAddressInUse(busy)).toBe(true);
    expect(isAddressInUse({ _tag: "ServeError", cause: { code: "EACCES" } })).toBe(false);
    expect(isAddressInUse({ _tag: "OtherError", cause: { code: "EADDRINUSE" } })).toBe(false);
    expect(isAddressInUse(new Error("EADDRINUSE"))).toBe(false);
  });

  it("names the port and how to choose another", () => {
    expect(addressInUseMessage(3773)).toBe(
      "Port 3773 is already in use. Stop what is using it, or start ViewCode on another port with --port <number>.",
    );
  });

  it("stays wired into the server command and the default-port pick", () => {
    const server = read("server.ts");
    expect(server).toMatch(
      /Effect\.catchIf\(\s*\(error\) => config\.listenPath === undefined && isAddressInUse\(error\)/,
    );
    expect(server).toContain("addressInUseMessage(config.port)");
    expect(read("config.ts")).toContain(
      "is in use, so ViewCode is using ${port}. Pass --port to choose one.",
    );
  });
});
