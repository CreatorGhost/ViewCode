import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import { viewCodeReviewStyleAccounts } from "./viewcodeReviewStyleAccounts.logic";
const auth: SourceControlProviderAuth = {
  status: "authenticated",
  account: Option.some("personal"),
  host: Option.some("github.com"),
  detail: Option.none(),
  accounts: [
    { host: "github.com", account: "work", active: false, authenticated: true },
    { host: "github.com", account: "personal", active: true, authenticated: true },
    { host: "github.com", account: "broken", active: false, authenticated: false },
    { host: "enterprise.example", account: "enterprise-work", active: true, authenticated: true },
  ],
};
it("keeps both usable accounts and enterprise styles under their own host, active first", () => {
  expect(viewCodeReviewStyleAccounts(auth)).toEqual([
    { host: "github.com", logins: ["personal", "work"] },
    { host: "enterprise.example", logins: ["enterprise-work"] },
  ]);
});
it("uses an authoritative token identity without losing saved-account styles or duplicating casing", () => {
  expect(
    viewCodeReviewStyleAccounts({
      ...auth,
      account: Option.some("WORK"),
      accounts: [
        ...auth.accounts!,
        {
          host: "github.com",
          account: "token-user",
          active: true,
          authenticated: true,
          environmentVariable: "GH_TOKEN",
        },
      ],
    }),
  ).toEqual([
    { host: "github.com", logins: ["WORK", "personal", "token-user"] },
    { host: "enterprise.example", logins: ["enterprise-work"] },
  ]);
});
it("supports old discovery and keeps a usable second account when the default credential is broken", () => {
  const { accounts: _accounts, ...legacy } = auth;
  expect(viewCodeReviewStyleAccounts(legacy)).toEqual([
    { host: "github.com", logins: ["personal"] },
  ]);
  expect(
    viewCodeReviewStyleAccounts({
      ...auth,
      status: "unauthenticated",
      account: Option.none(),
      accounts: [auth.accounts![0]!],
    }),
  ).toEqual([{ host: "github.com", logins: ["work"] }]);
});
