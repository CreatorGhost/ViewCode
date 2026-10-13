import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  followsSshHostname,
  parseSshConfigHostname,
  resolveSshAliasRemote,
  sshRemoteHost,
  withSshRemoteHost,
} from "./sshAliasRemote.ts";

describe("sshAliasRemote", () => {
  it("reads the host of SSH remotes only", () => {
    expect(sshRemoteHost("git@github.com-work:Acme/app.git")).toBe("github.com-work");
    expect(sshRemoteHost("gitlab-work:group/sub/app.git")).toBe("gitlab-work");
    expect(sshRemoteHost("ssh://git@work-gh:22/Acme/app.git")).toBe("work-gh");
    expect(sshRemoteHost("https://github.com/Acme/app.git")).toBeNull();
    expect(sshRemoteHost("/srv/git/app.git")).toBeNull();
    expect(sshRemoteHost("C:\\repos\\app")).toBeNull();
    // Never something ssh could read as an option.
    expect(sshRemoteHost("-oProxyCommand=x:a/b")).toBeNull();
  });

  it("swaps only the host", () => {
    expect(
      withSshRemoteHost("git@github.com-work:Acme/app.git", "github.com-work", "github.com"),
    ).toBe("git@github.com:Acme/app.git");
    expect(withSshRemoteHost("gitlab-work:g/app.git", "gitlab-work", "gitlab.com")).toBe(
      "gitlab.com:g/app.git",
    );
    expect(withSshRemoteHost("ssh://git@work-gh:22/Acme/app.git", "work-gh", "github.com")).toBe(
      "ssh://git@github.com:22/Acme/app.git",
    );
  });

  it("reads the real host from ssh -G output", () => {
    expect(
      parseSshConfigHostname(
        "user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_work\n",
      ),
    ).toBe("github.com");
  });

  it("follows an alias but never renames a real host the config routes elsewhere", () => {
    expect(followsSshHostname("github.com-work", "github.com")).toBe(true);
    expect(followsSshHostname("work", "git.acme.io")).toBe(true);
    expect(followsSshHostname("gitlab.company.com", "10.0.0.5")).toBe(false);
    expect(followsSshHostname("gitlab.company.com", "bastion.company.com")).toBe(false);
    expect(followsSshHostname("work", "10.0.0.5")).toBe(false);
    expect(followsSshHostname("github.acme.com-work", "github.acme.com")).toBe(true);
    expect(followsSshHostname("gitlab.company.com", "gitlab.company")).toBe(false);
  });

  it.effect("resolves an alias remote and leaves known hosts unread", () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];
      const read = (host: string) =>
        Effect.sync(() => {
          asked.push(host);
          return "user git\nhostname github.com\n";
        });
      expect(yield* resolveSshAliasRemote("git@gh-acme-test:Acme/app.git", read)).toBe(
        "git@github.com:Acme/app.git",
      );
      expect(yield* resolveSshAliasRemote("git@github.com:Acme/app.git", read)).toBe(
        "git@github.com:Acme/app.git",
      );
      expect(asked).toEqual(["gh-acme-test"]);
    }),
  );
});
