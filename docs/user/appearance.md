# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, hover a
theme and pick its sun (light) or moon (dark). Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile offers the same built-in themes as desktop,
starting with ViewCode Teal, plus the standard T3 Code palette. Tap a theme to use it, or tap
its sun or moon to use it for light or dark mode only; a dark-only theme applies to dark mode.
Mobile keeps its own theme, text, code, and terminal preferences and does not follow
environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.

## Window transparency

On macOS and Windows 11, the desktop app lets your desktop show through the sidebar and the
window around the chat, tinted by your theme. Turn it off with **Window transparency** in
**Settings → Appearance**; the change applies immediately. When **Reduce transparency** is on in
your system settings, the window stays solid. The browser and other systems always use a solid
background.

## Project colour

When you pick a single project in the rail and that project has a colour, the rail, the sidebar
and the composer's glow while an agent works take on its colour, lightly enough to sit on any
theme. With **All projects**, or a project without a colour, they use the theme's accent. In
**Settings → Appearance → Project colour**, turn off **Colour the app with the active project**
to keep the theme accent everywhere, or **Composer glow** to drop the glow.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Motion

The main sidebar, right panel, and terminal drawer slide open and closed in 300 ms by default. Use the
**Panel animations** slider to change the speed, up to 400 ms, or set it to 0 ms to open and close them
immediately. Motion is off when reduced motion is enabled in your operating system. Moving between
threads always snaps to the selected thread's panel state without replaying its transitions.

## Read aloud

On web and desktop, select the speaker button under a finished reply to hear it; select it again to
stop. Only the reply's prose is read: tool calls, progress updates, code blocks, and diagrams are
skipped, and links are read as their text. Use **Read latest reply aloud** and **Stop reading** in
the command palette, or assign `readAloud.latest` and `readAloud.stop` in **Settings →
Keybindings**. Reading stops when you switch threads.

Replies are read in a natural voice. It needs a one-time download of about 95 MB from ViewCode's
GitHub release, kept on the computer running ViewCode, and works offline afterwards. The first time
you select the speaker button the download starts and your system's voice reads that reply; the
progress shows beside the button. If the download is blocked, the system voice keeps reading and
**Settings → Appearance → Read aloud** shows why, with **Try again**.

Under **Read aloud** in **Settings → Appearance** you can:

- Choose the natural voice's size: small (about 95 MB), medium (about 165 MB), or large (about 330
  MB, the fullest sound), or **System voice (no download)**. Choosing a size downloads it once.
- Choose the voice and speed, and select **Preview** to hear them.
- Select **Remove downloaded voice** to delete every downloaded size and free the space.
- Set **Speak replies** to read each reply aloud when its turn finishes, without pressing anything.

**Speak replies** reads only the chat you have open, and only turns that finish while it is open.
**Summary** reads a short spoken version of the reply, which the turn's provider writes with its
smaller model a moment after the turn ends; the chat still shows the full reply. **Full reply**
reads the whole reply. The setting is saved on the server, so every device connected to it does the
same. Change it from the speaker menu in the chat's top bar or with **Speak mode** in the command
palette, and stop a reading the way you stop any other.

Speech runs on your device; your replies are never sent anywhere. Natural voices speak English. On
macOS, download more system voices in **System Settings → Accessibility → Spoken Content → System
voice → Manage Voices**.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3 Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. Additional connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, ViewCode falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
viewcode theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `viewcode theme set`. Run the command again to
reapply it, even if the name is unchanged.

`viewcode theme clear` removes the default without changing anyone's current theme. `viewcode theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from ViewCode into `~/.viewcode/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. An existing installation configured with a different home keeps that location. The filename supplies the theme ID: `nightfall.json`
can be selected with `viewcode theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. ViewCode
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
