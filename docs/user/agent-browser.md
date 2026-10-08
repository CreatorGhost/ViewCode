# Agent browser

Agents can open, read and test web pages in ViewCode's own browser, the same one you see in a
thread. They can go to a website or a dev server running in the project, click, type, read the
page and its console and network logs, and take screenshots to show you. You watch what they do in
the thread and can take over at any time.

## Turn it on

**Agent browser access** in **Settings → Integrations** is on by default. Turn it off for an
environment or a single project to keep agents out of the browser. A change applies when an agent
session next starts.

The browser lives in the ViewCode desktop app, so a desktop app must be open and connected to the
environment. Agents working on a remote server use the browser of a desktop app connected to it;
with only the web or mobile app open there is no browser for them to use, and they are told so.

## When your organization blocks MCP

Agents normally reach the browser through ViewCode's MCP tools. If your organization manages the
provider's MCP servers, or you run agents without ViewCode's tools, they use the `viewcode-browser`
command from their own shell instead. It drives the same browser with the same rules, so nothing
changes for you. In a sandboxed permission mode, a provider may be unable to reach ViewCode from its
shell; use **Full access** for those threads.

Screenshots an agent takes this way are saved with the environment's browser files, and the agent
can embed them in its reply.
