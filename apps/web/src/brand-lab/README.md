# Brand lab

Proposal-only, source-backed comparison of six identities and six light/dark UI
styles. Uses the application's Button, Badge, Input, Textarea, Popover and theme
role mapping with explicitly synthetic conversations. The sidebar and transcript
are specimens, not production containers. Compact mode is responsive web, not
React Native.

From `apps/web`, run `vp dev --config vite/brand-lab.config.ts` and open
`/brand-lab.html` on the URL Vite prints. This is a separate frontend only; it
needs no backend, credentials, database, or running desktop app.

Optional standalone build: `vp build --config vite/brand-lab.config.ts`.
Output goes to `.showcase/brand-lab` at the repository root, never the app's `dist`.
The regular application build does not include this entry.

- Pick a theme, light/dark appearance, and any vector mark independently.
- Expand child agents, select sample thread states, or open the provider menu.
- Demo messages stay in memory. A refresh resets all choices.
- No theme is installed; no production logo, native asset or preference changes.

Editable logo sources live in `assets/brand-directions` at the repository root.
Draft colors and typography live in `directions.ts`, and specimen-only layout
lives in `style.css`. Fonts use explicit local fallbacks, with no font downloads.
Native palette registration and launcher asset generation are intentionally
excluded until a direction is approved.
