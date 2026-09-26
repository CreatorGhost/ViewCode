# Review request: managed-mode implementation, onboarding picker, theme

> Superseded in scope by [`feature-audit.md`](feature-audit.md), which covers every ViewCode feature.

Read-only code review of what was built from
[`managed-mode-plan.md`](managed-mode-plan.md) after your two plan reviews.
Branch `claude/modest-meitner-9cuywa`; the range to review is
`ce24582a1..HEAD` (plus the gate commits `bfbb442b4`, `a43586d98`, `8334ba846`
just before it). Don't edit, commit or run the app.

## What was built

| Commit                                             | What                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bfbb442b4`, `a43586d98`                           | Selection state (`providerSelection: "pending" \| "chosen"`, absent = needs migration), one-time migration at settings load, gate applied in `deriveProviderInstanceConfigMap`, `server.detectProviders` (filesystem only) and `server.chooseProviders` (initial-choice) RPCs                                                                           |
| `8334ba846`                                        | client-runtime wrappers for the two RPCs                                                                                                                                                                                                                                                                                                                |
| `ca369b153`                                        | Launch guard applied once where the registry builds each instance (`withProviderLaunchGuard`): uncached lookup right before launch, runs the resolved path, fails closed (no PATH, pipes, POSIX shell strings), Windows `.cmd`/`.bat` recovered from the shell wrapping; OpenCode server owner guarded; Claude SDK via `requireClaudeSdkExecutablePath` |
| `4073c8a3e`                                        | If persisting the decision fails, providers stay off for that run                                                                                                                                                                                                                                                                                       |
| `52fbf8f1f`                                        | Claude enterprise policy: detect `managed-mcp.json`, drop `--strict-mcp-config` in the probe and title generation, surface the probe error, fall back to `claude auth status`                                                                                                                                                                           |
| `1303196a1`                                        | Built-in spawn trace (`<stateDir>/logs/spawn-trace.log`, first argument only, ~1 MB cap) and Help → Open Logs Folder                                                                                                                                                                                                                                    |
| `35260ecd7`                                        | Backend restart cap (3 abrupt exits in 2 min → stop, native dialog); title generation doesn't retry after 137/143 or a refused launch                                                                                                                                                                                                                   |
| `224b954c6`, `8fe5ba86c`                           | `build.sh --managed` writes instance-level choices + `providerSelection: "chosen"`; `--fresh` moves `~/.viewcode` and the desktop profile aside                                                                                                                                                                                                         |
| `a2cbacff8`, `39b18e52d`, `b8e97f89b`, `9ce2ced45` | Onboarding "Agents on <machine>" picker (7 tiles, all off, found/not installed), same picker in Settings → Providers while pending, a persistent "Choose agents" toast elsewhere; provider switches read off while pending                                                                                                                              |
| `3d3582246`, `769bdd655`, `6422f6c6f`, `8fe5ba86c` | Stronger amber accent; desktop see-through window (macOS vibrancy, Windows 11 Mica) for every theme; one-time switch of old profiles to the ViewCode theme with an Undo toast                                                                                                                                                                           |

Evidence (browser screenshots; the glass one simulates the OS blur with an
image): `docs/evidence/onboarding-choose-agents-dark.png`,
`settings-providers-pending-dark.png`, `composer-focus-before-after.png`,
`glass-simulated-viewcode-dark.png`, `new-look-toast.png`.

## What is verified, and what isn't

- Verified here (Linux sandbox): server typecheck; targeted server tests
  (1878 pass in the provider/textGeneration/settings/diagnostics run; the
  new selection/launch/binary/policy/trace tests 49/49); desktop and web
  typecheck; web unit tests for the new logic; the picker, Settings view,
  pending toast, composer focus and theme migration + Undo in a browser.
- Not verified: anything on macOS or Windows (vibrancy/Mica, Finder launch,
  Open Logs Folder, restart-cap dialog), a packaged DMG, the Claude policy fix
  against a real `managed-mcp.json`, and whether Claude sessions still get the
  ViewCode agents MCP server under an enterprise policy.
- Known: one root-only server test failure (listed in `docs/internals/viewcode.md`).

## Questions to answer

1. **Gate completeness.** Is there still any path that launches a provider
   CLI while selection is pending or for a disabled instance? Check the
   guard's placement in `ProviderInstanceRegistryLive` against every launcher
   you listed before (sessions, recovery, text generation, workspace scan,
   sign-in, maintenance/brew, OpenCode server owner, Claude SDK).
2. **Guard correctness.** The Windows path reverses `resolveSpawnCommand`'s
   escaping instead of resolving before wrapping. Is that sound for every
   form it produces? Any case where "not resolvable" still executes?
3. **Migration.** Does `decideProviderSelection` meet the rules (absent =
   needs migration, raw values before defaults, malformed file preserved,
   persist failure → off, pending survives restarts with new projects)?
4. **Choose semantics.** One write, every effective instance, stale second
   choice ignored, Settings toggle while pending = first choice. Any race
   between the settings write, reconciliation and the RPC reply?
5. **Onboarding UX.** Dead end if saving the choice keeps failing (the wizard
   hides its own Continue while a computer is pending). Is the toast the
   right fallback surface given there's no in-page banner slot?
6. **Claude enterprise policy.** Is dropping `strictMcpConfig` only when the
   policy file exists the right trigger? Anything else in the probe or title
   generation likely to collide with managed settings (`allowManagedHooksOnly`
   vs `disableAllHooks`)?
7. **Theme.** The glass rules now apply to every theme with `!important` on
   a few fills. Any upstream surface that will paint a solid block, or any
   readability risk? Is the one-time theme switch + Undo acceptable for users
   who deliberately chose an upstream theme?
8. **Upstream mergeability.** Which of these edits to upstream files could
   be smaller?
9. Anything that hides behaviour from security software, or reads that way.

Reply as: Blocking (file:line) / Should fix (file:line) / Ideas / Questions for the user.
