# Keeping ViewCode running

For remote access, the host must stay awake and ViewCode must remain running.
The desktop app can stay open in the background. For an npm installation, start
`viewcode serve` in a terminal and keep that session open; a terminal multiplexer
can keep it alive when you disconnect from SSH.

ViewCode does not install or update the upstream managed background service. If
you manage startup with your operating system or another supervisor, launch your
installed ViewCode executable as your normal user, keep the same `--base-dir`,
and give it the provider CLIs and environment variables it needs. Stop the old
process before restarting it after an update. See [Updating ViewCode](./updating.md).

Only one server may use a home directory at a time. The default is
`~/.viewcode`, with data under `userdata`. Use your configured location if you
previously selected a different home. Uninstalling the npm package does not
remove that data.

## After the v2 upgrade

The old `state.sqlite` stays beside `statev2.sqlite` as a recovery copy. After
checking your important threads and making a separate backup, you can remove
that old file manually. Follow [Removing the old database](./thread-migration.md#removing-the-old-database-after-the-upgrade)
for the exact files to keep and remove.
