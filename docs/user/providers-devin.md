# Devin

ViewCode runs Cognition's Devin CLI on your selected environment through its Agent
Client Protocol mode (`devin acp`). Devin uses your Devin or Windsurf account and its
own model catalog.

## Set up Devin

Install the [Devin CLI](https://docs.devin.ai/cli) on the machine running your
environment, then run `devin auth login` there. To use an API key instead, set
`WINDSURF_API_KEY` in the provider instance's environment variables in
**Settings > Providers**. Devin is turned on automatically when `devin` is on the
server's `PATH`; otherwise enable it there and set **Binary path** if needed.

The provider card shows whether Devin is signed in. A thread started without a login
cannot get answers; sign in, then send the message again.

## Models and threads

The model list comes from your Devin account and is read when provider status
refreshes. **Devin default** keeps the model Devin is configured with.

Plan mode uses Devin's Plan mode, and `/compact` summarizes a long conversation. Devin
threads resume their Devin session after a restart. Devin cannot rewind its own
history, and it cannot take a new message while it is working, so follow-ups wait for
the current turn to finish.

## Approvals

Devin's Code mode approves file edits on its own and asks before running commands,
so **Supervised**, **Auto-accept edits** and **Auto** behave the same. **Full access**
uses Devin's Bypass Permissions mode. See [permission modes](./permission-modes.md).

Devin threads get ViewCode's agent tools (child agents, agent messaging and reviews).
