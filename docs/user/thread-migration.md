# Upgrading older ViewCode threads

On your first V2 launch, ViewCode copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same data directory and migrates the copy. Your threads appear automatically, with user and assistant
conversation text imported as needed. You do not need to run an import command.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history. The copy happens only once: later conversations
and changes in either version do not sync to the other. Settings, attachments, and workspace files
remain shared.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app. On its first launch,
the V2 desktop app copies stashed prompts, unsent drafts, layout, and theme from V1. Anything you
change in V2 afterwards stays in V2.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. ViewCode also preserves child-agent parent relationships, side-chat kind,
thread goals, debug mode, project colors and PR watches. ViewCode brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. ViewCode selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

ViewCode does not currently have a whole-thread export command. Before a major server update, stop
the server and copy its `userdata` directory to a safe location. The default is
`~/.viewcode/userdata`. Existing servers configured to use `~/.t3` keep that location; a server started with `--base-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.

## Removing the old database after the upgrade

Keep the old database until you have checked your important projects and
threads, continued an old conversation successfully, and made a separate backup
of the whole `userdata` directory. The v2 app uses `statev2.sqlite`; the leftover
`state.sqlite` is a recovery copy and is no longer synchronized.

Quit ViewCode and stop the server before removing files. For an install whose
data directory is `~/.viewcode/userdata`, the old file is exactly
`~/.viewcode/userdata/state.sqlite`. If you use another home, including
`~/.t3` or `--base-dir <path>`, use that home's `userdata` directory
instead. Check the path before proceeding.

After backing up, move `state.sqlite` to a separate recovery folder using your
file manager. If `state.sqlite-wal` or `state.sqlite-shm` remain after shutdown,
move those siblings with it. To reclaim the space immediately after your separate backup is verified, delete
only those old `state.sqlite` files by hand instead of moving them. Otherwise,
delete the recovery folder later when you no longer need the old history. Keep `statev2.sqlite`, its siblings,
settings, secrets, attachments and workspace files. Removing `state.sqlite`
does not restore the old checkpoints or other history omitted during import.
