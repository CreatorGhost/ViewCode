import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { adminPolicyPath, readAdminPolicyFile } from "./viewcodeAdminPolicy.ts";

const BLOCKS_CODEX_AND_TAILSCALE = {
  blockedDrivers: ["codex"],
  tailscaleBlocked: true,
  problem: null,
};

// What MDM writes to /Library/Managed Preferences: a binary plist of
// { note: "IT ü", providers: { claudeAgent: { allowed: true }, codex: { allowed: false },
//   cursor: {} }, tailscale: { allowed: false } } (made with Python's plistlib).
const BINARY_PLIST = Buffer.from(
  "YnBsaXN0MDDTAQIDBAUPVG5vdGVZcHJvdmlkZXJzWXRhaWxzY2FsZWQASQBUACAA/NMGBwgJDA5bY2xhdWRlQWdlbnRVY29kZXhWY3Vyc29y0QoLV2FsbG93ZWQJ0QoNCNDRCg0IDxQeKDE4REpRVFxdYGFiAAAAAAAAAQEAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAGU=",
  "base64",
);

const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>providers</key>
	<dict>
		<key>claudeAgent</key>
		<dict><key>allowed</key><true/></dict>
		<key>codex</key>
		<dict><key>allowed</key><false/></dict>
		<key>cursor</key>
		<dict/>
	</dict>
	<key>tailscale</key>
	<dict><key>allowed</key><false/></dict>
</dict>
</plist>`;

it("keeps the policy at fixed machine-wide paths", () => {
  assert.equal(adminPolicyPath("darwin"), "/Library/Managed Preferences/dev.viewcode.app.plist");
  assert.equal(adminPolicyPath("linux"), "/etc/viewcode/policy.json");
  assert.equal(adminPolicyPath("win32"), "C:\\ProgramData\\ViewCode\\policy.json");
});

it.layer(NodeServices.layer)("readAdminPolicyFile", (it) => {
  const tempFile = (name: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-policy-" });
      return path.join(dir, name);
    });

  it.effect("treats a missing file as no policy", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(readAdminPolicyFile(yield* tempFile("policy.json")), {
        blockedDrivers: [],
        tailscaleBlocked: false,
        problem: null,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reads providers and Tailscale from a JSON policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const policyPath = yield* tempFile("policy.json");
      yield* fs.writeFileString(
        policyPath,
        JSON.stringify({
          providers: { codex: { allowed: false }, claudeAgent: { allowed: true }, cursor: {} },
          tailscale: { allowed: false },
        }),
      );
      assert.deepStrictEqual(readAdminPolicyFile(policyPath), BLOCKS_CODEX_AND_TAILSCALE);
    }).pipe(Effect.scoped),
  );

  it.effect("reads managed preferences as a binary or an XML plist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const binaryPath = yield* tempFile("binary.plist");
      const xmlPath = yield* tempFile("xml.plist");
      yield* fs.writeFile(binaryPath, BINARY_PLIST);
      yield* fs.writeFileString(xmlPath, XML_PLIST);
      assert.deepStrictEqual(readAdminPolicyFile(binaryPath), BLOCKS_CODEX_AND_TAILSCALE);
      assert.deepStrictEqual(readAdminPolicyFile(xmlPath), BLOCKS_CODEX_AND_TAILSCALE);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a file it cannot parse and blocks nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const jsonPath = yield* tempFile("policy.json");
      const plistPath = yield* tempFile("policy.plist");
      yield* fs.writeFileString(jsonPath, "{not json");
      yield* fs.writeFile(plistPath, BINARY_PLIST.subarray(0, 60));
      for (const policyPath of [jsonPath, plistPath]) {
        const policy = readAdminPolicyFile(policyPath);
        assert.deepStrictEqual(policy.blockedDrivers, []);
        assert.isFalse(policy.tailscaleBlocked);
        assert.include(policy.problem ?? "", policyPath);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a policy shape it does not understand", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const policyPath = yield* tempFile("policy.json");
      yield* fs.writeFileString(
        policyPath,
        JSON.stringify({ providers: ["codex"], tailscale: { allowed: "no" } }),
      );
      assert.deepStrictEqual(readAdminPolicyFile(policyPath), {
        blockedDrivers: [],
        tailscaleBlocked: false,
        problem: null,
      });
    }).pipe(Effect.scoped),
  );
});
