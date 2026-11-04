# Updating ViewCode

Update the machine that runs your agents as well as the clients you use. A client
and server must speak the same orchestration protocol; incompatible versions are
refused before a socket connection is established. This upgrade uses protocol 2.

## npm installation

On the server's machine, stop your running ViewCode process, then update and
restart it with the same options and data directory:

```sh
npm install -g viewcode-app@latest
viewcode serve
```

If a version notice names an exact published ViewCode version, install it with
`npm install -g viewcode-app@<version>`. Keep your usual `--base-dir`, `--host` and
other launch options when restarting. For a temporary npm launch, use
`npx viewcode-app@<version>` with those options instead.

ViewCode's npm package does not use the upstream managed runtime updater. A
connected client may offer a command to copy; run it on the named server host and
restart that server yourself.

## Desktop and source builds

Use the ViewCode desktop updater when your build supports it. If it opens a
release page instead, download the new ViewCode build and replace the installed
app. For a source build, update the ViewCode checkout and rebuild using the same
build procedure. Update remote hosts separately; restarting only the client does
not update the server running your agents.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
ViewCode must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a monitor, subagent, or background task
is woken and told that this work stopped. A background shell, such as a dev server,
does not wake it; the thread learns about it with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Upgrading older ViewCode threads](./thread-migration.md)
before continuing an important older thread.

## If an update fails

Check that you updated the machine named in the version notice. Keep a backup of
its data directory before retrying a major upgrade. Only one server can use a
ViewCode home at a time: stop that process before starting its replacement, or
use a separate `--base-dir` and pair with that server.

For a command-line server, check the installed package and restart it with your
usual options. For a desktop build that cannot apply an update, replace it with
the matching ViewCode build manually.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
Supported providers offer an update action; others show a manual command. Install
and update providers on the machine running the selected environment. An IT
administrator's policy continues to apply.

## Mobile updates

Install a matching ViewCode mobile build. Updating an environment from your phone
still acts on the server machine: a host that requires manual updates must be
updated there. Provider status and supported provider update actions are available
for connected environments when your client has permission to operate them.
