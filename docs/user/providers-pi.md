# Pi

ViewCode runs the [Pi coding agent](https://pi.dev) on your selected environment
through Pi's RPC mode. Pi loads your own setup from `~/.pi/agent`: its settings,
providers and models, extensions, skills and `AGENTS.md` files. A project's own `.pi`
settings, extensions and skills load only once you trust that folder in Pi (run `/trust`
there in the `pi` terminal app), because ViewCode cannot show Pi's trust prompt.

## Set up Pi

Install Pi 0.99 or newer on the machine running your environment
(`npm install -g @earendil-works/pi-coding-agent`), then run `pi` in a terminal and use
`/login`, or put a provider API key in the provider instance's environment variables in
**Settings > Providers**. Turn Pi on there, and set **Binary path** if
`pi` is not on the server's `PATH`.

## Models and threads

The model list is every model Pi has credentials for, named `provider/model`, read
when provider status refreshes. **Pi default** keeps the model from Pi's own settings.
Models that support thinking offer Pi's thinking levels in the composer.

Pi stores each thread's session itself, so a thread resumes its Pi session after a
restart, and you can open the same session in the `pi` terminal app. A message you
send while Pi is working steers the running turn. `/compact` summarizes a long
conversation. Pi cannot rewind its own history from ViewCode.

## Approvals

Pi has no permissions of its own, so ViewCode adds them: outside **Full access** it
asks before Pi runs a tool that is not a read, and **Auto-accept edits** lets file
edits through. **Auto** behaves like **Supervised**. Changing the permission mode
restarts the Pi process and resumes the session. See
[permission modes](./permission-modes.md).

Pi threads get ViewCode's agent tools (child agents, agent messaging and reviews).
