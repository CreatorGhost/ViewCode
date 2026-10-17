import { expect, it } from "vite-plus/test";
import { cursorCliLoginIdentity, cursorTokenMatchesIdentity } from "./cursorCredentialStore.ts";

it("accepts only the CLI account identity and never a different editor login", () => {
  const account = cursorCliLoginIdentity('{"authInfo":{"authId":" cli-account "}}');
  const token = `header.${Buffer.from('{"sub":"cli-account"}').toString("base64url")}.signature`;
  expect(account).toBe("cli-account");
  expect(cursorTokenMatchesIdentity(token, account)).toBe(true);
  expect(cursorTokenMatchesIdentity(token, "editor-account")).toBe(false);
  expect(cursorTokenMatchesIdentity("invalid", account)).toBe(false);
  expect(() => cursorCliLoginIdentity('{"authInfo":{"authId":" "}}')).toThrow("missing");
});
