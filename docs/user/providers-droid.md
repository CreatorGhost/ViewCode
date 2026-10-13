# Droid

ViewCode runs Factory's Droid CLI on your selected environment through its Agent
Client Protocol mode. Droid uses your Factory account and its own model catalog.

## Set up Droid

Install [Droid](https://docs.factory.ai/cli/getting-started/quickstart) on the machine
running your environment, then run `droid` once in a terminal and log in. To use an API
key instead, set `FACTORY_API_KEY` in the provider instance's environment variables in
**Settings > Providers**. Droid is turned on automatically when `droid` is on the
server's `PATH`; otherwise enable it there and set **Binary path** if needed.

If Droid is not signed in, starting a thread fails with a message telling you to log
in. Device pairing needs a terminal, so ViewCode does not start it for you.

## Models and threads

The model list comes from your installed Droid, including custom models from
`~/.factory/settings.json`. **Droid default** keeps the model Droid picks from its own
settings. Use **Refresh provider status** after adding custom models.

Plan mode uses Droid's read-only spec mode. Droid threads resume their Droid session
after a restart. Droid cannot rewind its own history, and it cannot take a new message
while it is working, so follow-ups wait for the current turn to finish.

## Approvals

ViewCode maps [permission modes](./permission-modes.md) to Droid's autonomy levels:
**Supervised** auto-approves only reads, **Auto-accept edits** uses low autonomy,
**Auto** uses medium autonomy, and **Full access** uses high autonomy. If your
organization caps autonomy, ViewCode uses the highest level it allows.

Droid threads get ViewCode's agent tools (child agents, agent messaging and reviews).
