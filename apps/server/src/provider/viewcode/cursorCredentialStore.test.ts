import { expect, it } from "vite-plus/test";
import { cursorCliLoginIdentity } from "./cursorCredentialStore.ts";

it("reads the CLI account identity and rejects a blank one", () => {
  expect(cursorCliLoginIdentity('{"authInfo":{"authId":" cli-account "}}')).toBe("cli-account");
  expect(() => cursorCliLoginIdentity('{"authInfo":{"authId":" "}}')).toThrow("missing");
});
