# ViewCode look: a Droppy-inspired design spec

Status: design target for re-theming the web and desktop clients. Mobile is out of scope (it keeps its Uniwind palette).

Goal: **Droppy-inspired, professional.** ViewCode should read as a calm, native-feeling tool: neutral glass surfaces with hairlines, a neutral text hierarchy built on one label colour, and an accent used sparingly. It is **not** a pixel clone of Droppy Code, and ViewCode keeps its own identity and features. Droppy values are the reference and the starting point. Where ViewCode deviates, the "ViewCode default" column says so and gives the value to use.

Reference: Droppy Code (MIT, macOS SwiftUI), <https://github.com/kalki-kgp/droppy-code> at commit `00e2358`. Source references are `path :: symbol`, relative to `DroppyCode/`. The reference checkout is not kept; everything needed is in this document.

Notation:

- `L(a)` is the label colour at opacity `a`. Droppy's `Chrome.overlay(a)` is `labelColor.opacity(a)`. macOS `labelColor` already carries 0.85 alpha, so the effective alpha is `0.85·a`. The CSS for it is `color-mix(in srgb, var(--vc-label) calc(a*100%), transparent)`, where `--vc-label` is the rgba label below, or the literal `rgb(255 255 255 / 0.85·a)` in dark and `rgb(0 0 0 / 0.85·a)` in light.
- `tint` is the theme's `surface` colour. `accent` is the theme's accent.
- The macOS text styles Droppy uses, in pt (= CSS px): body 13, callout 12, subheadline 11, caption 10, caption2 10, headline 13 bold, title3 15, title2 17.
- In the tables, **T** = token-only, **U** = touches an upstream component file, **V** = ViewCode-only file.

---

## 1. Principles

1. **Glass throughout, with the theme as a tint.** In Droppy (`Models/AppTheme.swift` header comment), a theme tints the glass and recolours the accent and status hues. It never paints opaque surfaces. One translucent window backdrop is followed by one inset content sheet, and that is all. There are no stacked opaque slabs, no card-on-card, and no coloured panels.
2. **Two planes only.** The sidebar has no fill and no border of its own; it sits directly on the window glass. The content (chat, settings page) sits on an inset rounded **sheet**, inset 10px from the window edge with radius 16 (`Views/Chrome/Chrome.swift :: detailSheet`, `RootView`). Separation comes from the sheet's edge, not from divider lines.
3. **Neutral label-colour hierarchy.** Every text, icon, fill, hover, selection and hairline is the label colour at a fixed opacity (`Chrome.overlay`). There are no tinted greys. Primary text is `labelColor`, secondary text is `secondaryLabelColor`, and chevrons are `tertiaryLabelColor`.
4. **Accent used sparingly.** In Droppy, the accent appears only on these elements:
   - the send button fill (`ComposerView.swift :: SendButton`);
   - the user message bubble at 14 % (`TimelineRows.swift :: UserMessageRow`);
   - link text, with no underline (`LinkParagraphView.swift :: render`);
   - list bullets and ordered-list numbers at 90 % (`MarkdownView.swift :: markerColor`), and checked task circles;
   - the unread dot, 7px (`SidebarView.swift :: ThreadBadge`, `ActivityStatus`);
   - an active chip: text in the accent over a 16 % accent fill (`Common/Components.swift :: ChipButtonStyle`);
   - the activity-view bell when on: 16 % fill (`SidebarView.swift :: ActivityViewToggle`);
   - the context-ring progress (`ComposerView.swift :: ContextMeter`);
   - the plain effort-track fill (`EffortSlider.swift :: TrackLook`);
   - the working spinner cells (`WorkingIndicators.swift :: GradientSpin.rowTints`) and the composer working dots;
   - the plan card at a 6 % fill, the command-palette selection at a 16 % fill, and system toggles, sliders and prominent buttons (via `.tint`).

   The accent is **never** used on: sidebar selection (neutral `L(0.12)`), hover, borders, headers, tool rows, code blocks, cards, window chrome, section titles or icons.

   **ViewCode deviates** (user feedback: the neutral default "doesn't feel like a change"): the amber also marks what is live or chosen — the send button, the user bubble (12 % / 10 %), the focused composer's hairline, an open composer chip, citations, the open thread in the sidebar (13 % fill), and tool-row icons and the "Worked for" chevron on hover or while expanded. Resting chrome, hover, headers and tool text stay neutral. The rules live in `viewcode-theme.css` ("Amber presence").

5. **Status hues only for status.** Success is used for diff additions and settled checks. Warning is used for "needs input" hands and declined tools. Danger is used for failures, deletions and destructive menu rows.
6. **Plain transcript.** Assistant replies are unboxed markdown with no avatar or author label. Tool calls are one secondary-text line each, with a 16px icon column and no card. Only the user message has a bubble.
7. **Motion is short and one-shot.** Hover takes 100ms. Panels use one spring. Rows fade up 4px. There are no continuous animations, except the working indicator while a turn runs (stepped, see §5.4) and the effort-slider exception documented in `docs/internals/viewcode.md` (Composer picker).
8. **Small, dense type.** Body text is 13px. Chrome labels are 12.5px medium. Tool rows are 12px secondary. Nothing in the chrome is larger than 15px, apart from empty-state titles.

---

## 2. Tokens

### 2.1 macOS label colours (reference values)

| macOS colour                                        | Dark                              | Light              | Flattened on the dark sheet `#19191B` | Flattened on the light sheet `#FAFAFA` |
| --------------------------------------------------- | --------------------------------- | ------------------ | ------------------------------------- | -------------------------------------- |
| `labelColor` (primary)                              | `rgb(255 255 255 / .85)`          | `rgb(0 0 0 / .85)` | `#DEDEDF`                             | `#262626`                              |
| `secondaryLabelColor`                               | `rgb(255 255 255 / .55)`          | `rgb(0 0 0 / .50)` | `#999999`                             | `#7D7D7D`                              |
| `tertiaryLabelColor`                                | `rgb(255 255 255 / .25)`          | `rgb(0 0 0 / .26)` | `#555556`                             | `#B9B9B9`                              |
| `quaternaryLabelColor` (SwiftUI `.quaternary` fill) | `rgb(255 255 255 / .10)`          | `rgb(0 0 0 / .10)` | n/a                                   | n/a                                    |
| `separatorColor`                                    | `rgb(255 255 255 / .10)`          | `rgb(0 0 0 / .10)` | n/a                                   | n/a                                    |
| `placeholderTextColor`                              | `rgb(255 255 255 / .25)`          | `rgb(0 0 0 / .25)` | ViewCode default `#6B6B6C` (0.35)     | ViewCode default `#A0A0A0`             |
| `controlAccentColor` (blue)                         | `#0A84FF`                         | `#007AFF`          | n/a                                   | n/a                                    |
| systemGreen                                         | `#32D74B`                         | `#28CD41`          | n/a                                   | n/a                                    |
| systemOrange                                        | `#FF9F0A`                         | `#FF9500`          | n/a                                   | n/a                                    |
| systemRed                                           | `#FF453A`                         | `#FF3B30`          | n/a                                   | n/a                                    |
| `Chrome.gray / blue / orange` (fixed)               | `#8E8E93` / `#0A7AFF` / `#FF9500` | same               | n/a                                   | n/a                                    |

ViewCode default: text roles use the **flattened opaque** values, so the `--contrast-*` mixes in `index.css` stay correct. Overlays and hairlines use the **alpha** values, as the stock dark theme already does with `--border: alpha(white/6%)`.

### 2.2 Overlay opacities (`Chrome.overlay(a)`)

| Use                                    | Droppy `a`                                            | Effective alpha (×0.85) | CSS (dark / light)                        | Source                                          |
| -------------------------------------- | ----------------------------------------------------- | ----------------------- | ----------------------------------------- | ----------------------------------------------- |
| Sidebar row, hover                     | 0.06                                                  | 0.051                   | `rgb(255 255 255/.05)` / `rgb(0 0 0/.05)` | `Chrome.swift :: SidebarRow.fill`               |
| Sidebar row, selected                  | 0.12                                                  | 0.102                   | `/.10`                                    | same                                            |
| Chrome icon, active (circle inset 1px) | 0.12                                                  | 0.102                   | `/.10`                                    | `ChromeIconLabel`                               |
| Popover item, hover; suggestion row    | 0.10                                                  | 0.085                   | `/.085`                                   | `Popovers.swift :: PopoverItem`                 |
| Search field fill                      | 0.07                                                  | 0.06                    | `/.06`                                    | `SidebarSearchField`                            |
| Round toggle, hover (bell, bolt)       | 0.08 / 0.06–0.10                                      | ≈0.07                   | `/.07`                                    | `ActivityViewToggle`                            |
| Settings card fill                     | 0.03                                                  | 0.026                   | `/.026`                                   | `ChromeCard`                                    |
| Commit/editor text area fill           | 0.05                                                  | 0.043                   | `/.04`                                    | `ChatView.swift :: CommitSheet`                 |
| Window hairline stroke (1px)           | 0.14                                                  | 0.12                    | `/.12`                                    | `WindowBackdrop`                                |
| Chrome capsule divider (1×14)          | 0.22                                                  | 0.19                    | `/.19`                                    | `ChromeDivider`                                 |
| Disabled chrome glyph                  | 0.32                                                  | 0.27                    | `/.27`                                    | `ChromeIconLabel`                               |
| Chrome glyph at rest / hover           | 0.92 / 1.0 of label                                   | 0.78 / 0.85             | `/.78` → `/.85`                           | `ChromeIconLabel`                               |
| Effort track, empty                    | 0.10                                                  | 0.085                   | `/.085`                                   | `EffortSlider`                                  |
| Effort stop, unfilled                  | 0.32                                                  | 0.27                    | `/.27`                                    | same                                            |
| Lifted (dragged) row                   | 0.12 + shadow `0 4px 10px rgb(0 0 0/.28)`, scale 1.02 | n/a                     | n/a                                       | `SidebarThreadRow`                              |
| Resize grip / glow (label)             | 0.6 / 0.05 hover, 0.10 drag                           | n/a                     | n/a                                       | `WindowChrome.swift :: SidebarResizeHandleView` |

SwiftUI `.quaternary.opacity(x)` fills are `rgb(255 255 255 / .10·x)` in dark and `rgb(0 0 0 / .10·x)` in light. Code blocks use x=0.45 (≈4.5 %). Tables and the todo list use 0.35 and 0.30. The file card uses 0.32. Tool detail blocks use 0.45. The approval code block uses 0.5. The "Show earlier" pill uses 0.5.

### 2.3 Metrics (`Views/Chrome/Chrome.swift :: Chrome`)

| Token                                                                                                             | Value                                 | CSS variable to add (V)                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `windowCornerRadius`                                                                                              | 26                                    | `--vc-window-radius: 26px`                 |
| `sheetInset`                                                                                                      | 10                                    | `--vc-sheet-inset: 10px`                   |
| `sheetCornerRadius`                                                                                               | 16 (26−10)                            | `--vc-sheet-radius: 16px`                  |
| Traffic lights: diameter / spacing / leading / top / clearance                                                    | 14 / 9 / 18 / 16 / 10; group width 60 | desktop only                               |
| `iconFont` (standalone control glyph)                                                                             | 12px semibold                         | `--vc-icon: 12px`                          |
| `inlineIconFont` (glyph beside text)                                                                              | 11px semibold                         | `--vc-icon-inline: 11px`                   |
| `chevronFont`                                                                                                     | 8px bold                              | `--vc-chevron: 8px`                        |
| `chromeHorizontalPadding` / `chromeTopPadding`                                                                    | 14 / 12                               | `--vc-chrome-px`, `--vc-chrome-pt`         |
| `capsuleContentHeight` / vertical pad / capsule height                                                            | 28 / 2 / **32**                       | `--vc-capsule-h: 32px`                     |
| `capsuleHorizontalPadding` / `iconCapsuleInnerPadding`                                                            | 12 / 3                                | n/a                                        |
| `dividerHeight`                                                                                                   | 14 (1px wide)                         | n/a                                        |
| `contentBreathBelowChrome` / `contentTopInset`                                                                    | 28 / 72 (12+32+28)                    | `--vc-content-top: 72px`                   |
| `veilHeight`                                                                                                      | 72                                    | n/a                                        |
| Compact-title scroll range                                                                                        | 10 → 44px of travel, quantised 0.02   | n/a                                        |
| `rowHeight` / `rowCornerRadius` / `rowHorizontalPadding`                                                          | 28 / 7 / 8                            | `--vc-row-h: 28px`, `--vc-row-radius: 7px` |
| `iconSize` (icon column) / `symbolSize`                                                                           | 20 / 14                               | n/a                                        |
| `groupGap` / `listInset`                                                                                          | 10 / 10                               | n/a                                        |
| `cardCornerRadius`                                                                                                | 16                                    | `--vc-card-radius: 16px`                   |
| `sectionSpacing` / `sectionHeaderSpacing`                                                                         | 20 / 10                               | n/a                                        |
| `contentHorizontalPadding` / `rowControlTrailingPadding`                                                          | 16 / 10                               | n/a                                        |
| Timeline `rowSpacing` / `hoverLineHeight` / `iconWidth` / `iconSpacing` (`TimelineRows.swift :: TimelineMetrics`) | 20 / 22 / 16 / 8                      | `--vc-row-gap: 20px`                       |
| Chat column max width / side padding                                                                              | 820 / 20                              | `--vc-column: 820px`                       |

### 2.4 Typography

Font: the system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`). ViewCode's `--font-sans` is already this. Mono: `ui-monospace, "SF Mono", Menlo`. Weights: regular 400, medium 500, semibold 600, bold 700.

| Element                               | Size / weight                                                 | Colour                                     | Source                                        |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Sidebar row title                     | 13 / 400 (500 when selected or unread)                        | label 0.92 (1.0 selected)                  | `SidebarRow`, `ThreadRowFace`                 |
| Settled / helper row                  | 12 / 400                                                      | label 0.55 (0.75 selected) / 0.80          | `ThreadRowFace`, `SidebarHelperRow`           |
| Activity-row project line             | 12 (icon 10)                                                  | secondary                                  | `ThreadRowFace`                               |
| Section header (sidebar activity)     | 12 / 600                                                      | secondary                                  | `ActivityHeader`                              |
| Row trailing time / count             | 11, tabular numbers                                           | secondary 0.8                              | `SidebarThreadRow`                            |
| Search field text / icon              | 13 / icon 12 medium                                           | text label, icon secondary 0.85            | `SidebarSearchField`                          |
| Chrome capsule text                   | 12.5 / 500                                                    | label 0.92 → 1.0 hover                     | `ChromeTextMenu`                              |
| Compact title                         | 15 / 600                                                      | label                                      | `ChromeCompactTitle`                          |
| Assistant body                        | 13 / 400, line-height ≈1.38 (18px)                            | label                                      | `MarkdownView` default `markdownPointSize` 13 |
| Thinking text                         | 12, dimmed                                                    | secondary                                  | `ThreadTimeline.swift :: WorkingIndicator`    |
| H1 / H2 / H3 / H4+                    | 17/600, 15/600, 13/700, 11/600; top pad 6 (H1–H2), 2 (others) | label                                      | `MarkdownBlockView.headingFont`               |
| Inline code                           | mono, size −1 (12), **no background, no border**              | label                                      | `LinkParagraphView.attributed`                |
| Code block                            | mono 12; header (language / copy) 10                          | label; header secondary                    | `CodeBlock`                                   |
| Tool row, work summary, working line  | 12 (callout)                                                  | secondary; chevron tertiary 10/600         | `ToolRow`, `WorkGroup`                        |
| Tool icon                             | 10 (caption)                                                  | secondary; failed danger; declined warning | `ToolStatusIcon`                              |
| Diff stats                            | 10, tabular numbers                                           | success / danger                           | `Common/Components.swift :: DiffStatLabel`    |
| User bubble text                      | 13 / 400                                                      | label                                      | `UserMessageRow`                              |
| Composer text                         | 14 / 400                                                      | label                                      | `ComposerView`                                |
| Chip                                  | 12                                                            | secondary (accent when active)             | `ChipButtonStyle`                             |
| Popover item / detail / header / note | 13 / 12 / 11·600 / 12                                         | label / secondary / secondary / secondary  | `Popovers.swift`                              |
| Settings row title / detail           | 13 / 11                                                       | label / secondary                          | `ChromeRow`                                   |
| Settings section title                | 13 / 600                                                      | secondary                                  | `ChromeSection`                               |
| Empty-state title                     | 17 / 500 (welcome 34/600)                                     | label                                      | `RootView.swift :: NoThreadView`              |

### 2.5 Motion

| Droppy                                                                                      | Use                                                       | CSS approximation (V: `--vc-*`)                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Chrome.hover` = easeOut 0.10s                                                              | every hover fill and colour                               | `100ms cubic-bezier(0,0,0.58,1)`                                                                              |
| `Chrome.panelSlide` = spring(response 0.32, damping 0.9); easeOut 0.18 under reduced motion | sidebar toggle, panels, project expand, row insert/remove | `320ms cubic-bezier(0.22,1,0.36,1)`; reduced: `180ms ease-out` (ViewCode's existing `--ease-drawer` is close) |
| `.softAppear` = smooth 0.32: opacity 0→1, y +4→0; removal fade 0.12 easeOut                 | new timeline rows, tabs, chips                            | `320ms cubic-bezier(0.25,0.1,0.25,1)`, out `120ms ease-out`; opacity and transform only, never blur           |
| sidebar row: insert easeIn 0.18 with 0.12 delay; remove easeOut 0.06                        | sidebar list changes                                      | as given                                                                                                      |
| `.snappy(0.2–0.25)`                                                                         | expand/collapse, chevron rotate 0→90°                     | `220ms cubic-bezier(0.2,0.9,0.1,1)`                                                                           |
| `.smooth(0.35)`                                                                             | scroll to bottom                                          | `scroll-behavior: smooth`                                                                                     |
| Jump-to-latest in/out: spring(0.38, 0.78); scale 0.6→1 plus y 10                            | button above the composer                                 | `380ms cubic-bezier(0.34,1.3,0.64,1)`                                                                         |
| Resize grip: easeOut 0.18                                                                   | sidebar edge                                              | `180ms ease-out`                                                                                              |
| Lifted row: spring(0.25, 0.8), scale 1.02                                                   | drag reorder                                              | `250ms` spring-like                                                                                           |
| Panel transition: in scale 0.92 + fade, out scale 0.96 + fade                               | floating panels, popovers                                 | `panelSlide`                                                                                                  |

---

## 3. Window backdrop

Source: `Views/Chrome/Chrome.swift :: WindowBackdrop`, `DetailSheetModifier`, `PaneTopVeil`; `Views/Chrome/WindowChrome.swift :: WindowChrome.configure`.

The layers, back to front:

1. **Window glass.** Liquid Glass `regular` fills the rounded window (radius 26). The window is `isOpaque=false`, has a clear background, a transparent title bar and a full-size content view, and shows no separator under the title bar.
2. **Scrim.** Black in dark, white in light. The opacity comes from the Transparency setting `t ∈ [0,1]`, stock 0.5 (`AppSettings.defaultBackdropOpacity`): `t ≤ 0.5 → stock·(t/0.5)`, else `stock + (1−stock)·((t−0.5)/0.5)`. **Stock is dark 0.26 and light 0.18.** At `t=1` the backdrop is solid.
3. **Tint.** `tint` at 0.12 over the whole window.
4. **Hairline.** A 1px inner stroke of `L(0.14)` (dark `rgb(255 255 255/.12)`, light `rgb(0 0 0/.12)`).
5. **Content sheet** (`detailSheet`). It is inset 10 on the top, right and bottom, and on the left only when the sidebar is hidden (`RootView`), with radius 16. Its fill is a base of black 0.22 (dark) or white 0.30 (light), plus `tint` at 0.22 (dark) or 0.16 (light). The sheet has no border and no shadow.
6. **Top veil** (per pane, 72px, visible only once content scrolls under the chrome). Glass, then a scrim (dark `0.42+0.28p`, light `0.48+0.30p`), then tint (0.22 dark, 0.16 light). The veil's opacity is `0.08+0.92p`. It is masked by a vertical gradient: black from 0 to 38 %, then clear at 100 %. `p` is the scroll progress over 10–44px.
7. **Capsules** (`chromeGlassCapsule`): regular interactive glass tinted with `tint` at 0.30.

### 3.1 Web (no desktop behind the page)

`backdrop-filter` cannot see the desktop, so paint the flattened colours. The layers stay in CSS so that Electron can switch to translucent.

| Surface                          | Dark (ViewCode default)                | Light (ViewCode default) | Formula for other themes                                        |
| -------------------------------- | -------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Window / sidebar (`--vc-window`) | `#1F1F21`                              | `#EDEDEF`                | `mix(tint w_win, base)`; base dark `#1F1F21`, light `#ECECEE`   |
| Sheet (`--vc-sheet`)             | `#19191B`                              | `#FAFAFA`                | `mix(tint w_sheet, base)`; base dark `#18181A`, light `#F7F7F8` |
| Window hairline                  | `inset 0 0 0 1px rgb(255 255 255/.12)` | `rgb(0 0 0/.10)`         | n/a                                                             |

Weights: Droppy uses w_win = 0.12 and w_sheet = 0.22. **ViewCode default for named themes in opaque mode: w_win = 0.35 and w_sheet = 0.55.** Without a wallpaper showing through, Droppy's weights leave every dark theme the same grey, so the theme would be invisible. Neutral themes are unaffected either way.

- On the web the "window" is the viewport. Do not draw the 26px outer radius or the hairline there; keep the 10px sheet inset and the 16px sheet radius.
- Floating glass (capsules, composer, popovers, palette): `background: color-mix(in srgb, var(--vc-sheet) 72%, transparent)` plus `backdrop-filter: blur(24px) saturate(1.6)`, over what scrolls beneath. Add a hairline `inset 0 0 0 0.5px L(0.10)` and a top specular edge `inset 0 0.5px 0 rgb(255 255 255/.10)` (dark only). Shadow, at most `0 1px 2px rgb(0 0 0/.12)` light and `0 2px 8px rgb(0 0 0/.35)` dark. The `@supports not (backdrop-filter)` fallback is the opaque `--vc-sheet` lifted by `L(0.06)`.
- Keep ViewCode's existing `--glass-blur` and `--glass-opacity` variables, but set them from the ViewCode theme file (§6): dark blur 24px, light blur 20px, opacity 72 %, saturation 1.6.

### 3.2 Electron desktop

| Platform           | BrowserWindow options                                                                                                                                                                                                                                                                                                                                                                              | Renderer                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS              | `transparent: false`, `vibrancy: 'under-window'` (or `'sidebar'`), `visualEffectState: 'followWindow'`, `backgroundColor: '#00000000'`; keep `titleBarStyle: 'hiddenInset'`. Traffic lights: `{x: 18, y: 16}` with the sidebar shown. Droppy moves them to `x = 10+14 = 24`, `y = 10+12+(32−14)/2 = 31` with the sidebar hidden (`WindowChrome.placeTrafficLights`); ViewCode may keep them fixed. | `html, body` transparent. Paint the scrim and tint as rgba layers on the root: dark `rgb(0 0 0/.26)` then `tint/.12`; light `rgb(255 255 255/.18)` then `tint/.12`. The sheet uses black .22 / white .30 plus the tint .22 / .16 as rgba. |
| Windows 11         | `backgroundMaterial: 'mica'` (sidebar-style, calm) or `'acrylic'` (more see-through); `backgroundColor: '#00000000'`; keep `titleBarOverlay` with `color: '#00000000'`                                                                                                                                                                                                                             | same rgba layers as macOS                                                                                                                                                                                                                 |
| Windows 10 / Linux | opaque; `backgroundColor` = `--vc-window` (`#1F1F21` dark / `#EDEDEF` light)                                                                                                                                                                                                                                                                                                                       | flattened colours from §3.1                                                                                                                                                                                                               |

- Set a root attribute, for example `html[data-vc-translucent]`, only when the desktop bridge reports that vibrancy or material is active. Without it, the web values apply.
- The initial `backgroundColor` in `apps/desktop/src/window/DesktopWindow.ts :: getInitialWindowBackgroundColor` is `#0a0a0a` / `#ffffff`. Change it to `#1F1F21` / `#EDEDEF` so the window doesn't flash.
- **Transparency setting** (optional, Droppy `BackdropOpacitySlider`): a 140px slider between two 11px icons (dotted circle = clear, filled circle = solid), with a reset button that appears once the value is away from 0.5. It only affects translucent mode.

---

## 4. AppTheme palette (`Models/AppTheme.swift :: AppTheme.palette`)

Fields: `scheme` (nil = follow the system), `accent` (nil = system control accent), `surface` (the glass tint; always set), and `success`, `warning`, `danger` (nil = systemGreen, systemOrange, systemRed). **The Droppy default is `system`.** Its surface is dynamic: `#1E1E20` dark, `#FFFFFF` light.

The picker badge (`AppTheme.swatch`) is a circle with a linear gradient from top-leading to bottom-trailing: surface 0 %, surface 42 %, accent 100 %. Its rim is a 0.5px stroke at `primary .22`. The System badge is split white/`#1E1E20` down the vertical middle. The picker lists System first, then a "Dark" header and the dark themes, then a "Light" header and the light themes (`SettingsView.swift :: ThemePickerButton`).

| id              | Name             | Detail                | Scheme | Accent | Surface         | Success | Warning | Danger |
| --------------- | ---------------- | --------------------- | ------ | ------ | --------------- | ------- | ------- | ------ |
| system          | System           | Follows your Mac      | system | system | 1E1E20 / FFFFFF | sys     | sys     | sys    |
| light           | Light            | Light · System accent | light  | system | FFFFFF          | sys     | sys     | sys    |
| dark            | Dark             | Dark · System accent  | dark   | system | 1E1E20          | sys     | sys     | sys    |
| catppuccinMocha | Catppuccin Mocha | Dark · Mauve          | dark   | CBA6F7 | 1E1E2E          | A6E3A1  | F9E2AF  | F38BA8 |
| catppuccinLatte | Catppuccin Latte | Light · Mauve         | light  | 8839EF | EFF1F5          | 40A02B  | DF8E1D  | D20F39 |
| dracula         | Dracula          | Dark · Purple         | dark   | BD93F9 | 282A36          | 50FA7B  | FFB86C  | FF5555 |
| tokyoNight      | Tokyo Night      | Dark · Blue           | dark   | 7AA2F7 | 1A1B26          | 9ECE6A  | E0AF68  | F7768E |
| nord            | Nord             | Dark · Frost          | dark   | 88C0D0 | 2E3440          | A3BE8C  | EBCB8B  | BF616A |
| gruvbox         | Gruvbox          | Dark · Orange         | dark   | FE8019 | 282828          | B8BB26  | FABD2E  | FB4934 |
| gruvboxLight    | Gruvbox Light    | Light · Rust          | light  | AF3A03 | FBF1C7          | 79740E  | B57614  | 9D0006 |
| oneDark         | One Dark         | Dark · Blue           | dark   | 61AFEF | 282C34          | 98C379  | E5C07B  | E06C75 |
| everforest      | Everforest       | Dark · Green          | dark   | A7C080 | 2D353B          | A7C080  | DBBC7F  | E67E80 |
| kanagawa        | Kanagawa         | Dark · Wave blue      | dark   | 7E9CD8 | 1F1F28          | 98BB6C  | D7A657  | E82424 |
| rosePine        | Rosé Pine        | Dark · Rose           | dark   | EB6F92 | 191724          | 9CCFD8  | F6C177  | EB6F92 |
| solarizedDark   | Solarized Dark   | Dark · Blue           | dark   | 268BD2 | 002B36          | 859900  | B58900  | DC322F |
| solarizedLight  | Solarized Light  | Light · Blue          | light  | 268BD2 | FDF6E3          | 859900  | B58900  | DC322F |
| githubDark      | GitHub Dark      | Dark · Blue           | dark   | 4493F8 | 0D1117          | 3FB950  | D29922  | F85149 |
| githubLight     | GitHub Light     | Light · Blue          | light  | 0969DA | FFFFFF          | 1A7F37  | 9A6700  | CF222E |
| ayu             | Ayu              | Dark · Amber          | dark   | E6B450 | 0F1419          | AAD94C  | FFB454  | F58572 |
| nightOwl        | Night Owl        | Dark · Blue           | dark   | 82AAFF | 011627          | C5E478  | ECC48D  | EF5350 |
| monokai         | Monokai          | Dark · Pink           | dark   | F92672 | 272822          | A6E22E  | FD971F  | F92672 |
| claude          | Claude           | Dark · Terracotta     | dark   | C15F3C | 1A1816          | 51A556  | C9A227  | D97757 |
| claudeLight     | Claude Light     | Light · Terracotta    | light  | C15F3C | FAF9F5          | 2E7D32  | 9A6700  | B3261E |
| codex           | Codex            | Dark · Magenta        | dark   | D946EF | 101014          | 3FB950  | D29922  | F85149 |
| cursor          | Cursor           | Dark · Frost          | dark   | 88C0D0 | 181818          | 3FA266  | F1B467  | E34671 |
| matrix          | Matrix           | Dark · Green          | dark   | 00E676 | 000000          | 00E676  | FFD600  | FF5252 |

**ViewCode default theme** (replaces today's violet `VIEWCODE_THEME`). Name: "ViewCode"; scheme follows the system, with both variants defined. It is the neutral Droppy `system` look with a warm **amber** accent taken from the ViewCode logo (the user rejected blue and violet) instead of loud `#0A84FF`/`#007AFF` or violet:

| Field                      | Dark                            | Light                           | Why it deviates from Droppy                                                                                                               |
| -------------------------- | ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| accent                     | `#E0A15A`                       | `#9A5714`                       | Droppy uses the system blue; ViewCode uses its logo amber on live and chosen elements (§1.4). Light value is darkened for ≥4.5:1 on white |
| surface (tint)             | `#1E1E20`                       | `#FFFFFF`                       | same as Droppy                                                                                                                            |
| success                    | `#5BB98B`                       | `#2E8B57`                       | system green is neon on dark glass                                                                                                        |
| warning                    | `#C9B037`                       | `#7E6A00`                       | yellow, not orange, so it never reads as the amber accent                                                                                 |
| danger                     | `#E5675F`                       | `#C4392F`                       | calmer than systemRed                                                                                                                     |
| primary action (send, CTA) | fill `#E0A15A`, glyph `#1A1206` | fill `#9A5714`, glyph `#FFFFFF` | as Droppy (accent fill); an empty composer's send button is a neutral `L(.10)` disc instead of a faded amber one                          |
| user bubble                | accent 12 %: `#312923`          | accent 10 %: `#F0EAE3`          | Droppy uses accent 14 %; named themes keep accent 14 %                                                                                    |

The Droppy-ported themes are optional. Ship at least **Claude / Claude Light** (needed for acceptance) through the derivation in §6.3. Do not ship Codex (`#D946EF`) or Dracula/Catppuccin as the default; purple accents are allowed only as opt-in named themes.

---

## 5. Layout per region

### 5.1 Window chrome / title bar

- **There is no title bar strip.** Content runs to the top edge, and the transparent title bar is only a drag region that reaches the bottom of the chrome row (`WindowChrome.titlebarHeight = 10+12+32 = 54`).
- The traffic lights sit in the sidebar's top corner (leading 18, top 16). The sidebar reserves `16+14 = 30px` above its search field.
- The chat has a **floating chrome row** (`ChatView.swift :: ChatChromeRow`) laid over the sheet at top 12, horizontal padding 14, with a 10px gap between items. There is no background bar and no bottom border. From leading to trailing:
  1. a Threads circle (only when the sidebar is hidden; the row then clears the traffic lights by 60+10px);
  2. a New-thread circle;
  3. the Hydra/team button (a ViewCode analogue if one exists);
  4. the permissions circle menu;
  5. the branch text-capsule menu;
  6. the compact title (flexible width; fades in on scroll);
  7. then, spaced 8 apart: a capsule group holding [Open in | Scripts | Git actions], and a capsule holding [Terminal | Diff].
- **Circle button** (`ChromeCircleButton`): 32×32 glass circle with a 12px semibold glyph at label 0.92 (1.0 on hover).
- **Capsule** (`ChromeCapsule`): height 32 and inner padding 3. Items are 28×28 icon buttons separated by 1×14 dividers at `L(0.22)`. An active item shows a filled circle of `L(0.12)` inset by 1.
- **Text capsule** (`ChromeTextMenu`): 11px icon, 12.5/500 title and an 8px bold chevron in secondary. Horizontal padding 12, gaps 6.
- Everything scrolls under the row, and the veil (§3 item 6) fades in behind it.

### 5.2 Sidebar (`Views/Sidebar/SidebarView.swift`, `WindowChrome.swift :: SidebarLayout`)

- **Width** 268 by default, 210 minimum, 440 maximum. Dragging below 110 collapses it.
- **Resize handle**: 9px hit area on the edge. The grip is 2.5 wide, grows from 10 to 22 tall on hover, and is drawn in the label colour at 0.6.
- **No fill, no border.** It is window glass.
- **Top**:
  - the traffic-light clearance of 30;
  - then a row, padding 14 above and 10 at the sides, holding the search field (capsule, 30 tall, fill `L(0.07)`, padding 9, gap 6, 12px magnifier) and a 30×30 circle "activity" toggle. The toggle's bell is 12/600, secondary when off; when on it is the accent over a 16 % accent fill.
- **List**:
  - padding 10 at the sides, 12 top and 8 bottom; rows 1px apart; 10px between project groups;
  - the scroll indicator is hidden.
- **Project row**: a 28 tall `SidebarRow`.
  - Folder glyph 14 in a 20 column at label 0.85, then the title at 13.
  - The trailing edge shows the thread count (11, tabular, secondary) when the project is collapsed. On hover it shows a 20×20 ellipsis and a plus, both 11/600 secondary.
- **Thread row**:
  - Height 28 in project mode. In activity mode it grows to 48 with a second line: a 10px folder or branch glyph and the 12px project name in secondary, vertical padding 7.
  - The badge in the 20 column is the provider logo at 14. It becomes the working mini-spinner while running, an orange hand when input is needed, or a pin.
  - Unread shows as a 7px accent dot at the badge's top-right, offset (+2.5, −2.5), or a danger dot if the last turn failed.
  - The trailing edge shows the relative time (11, tabular, secondary 0.8). On hover it swaps to archive/settle and ellipsis buttons (20×20).
- **Row states**: rest is clear; hover is `L(0.06)`; selected is `L(0.12)`, with the title at weight 500 and label 1.0. Radius 7, horizontal padding 8. **Never use an accent fill, accent bar or border for selection.**
- **Settled rows**: 24 tall, 12px title at 0.55, a success check at the front (inset 6), and a 4px gap above the settled group.
- **Helper (child) rows**: 24 tall and 12px. A 28px connector column holds a dotted line (1px, dash `0.1 3.6`, round caps) in secondary at 0.45 (0.9 on hover) at x=18, with a tick to the row.
- **Activity headers** ("Needs attention", "Today", "Yesterday", weekday, date, "Settled"): 12/600 secondary, padding 8 at the sides, 14 above (2 for the first), 4 below.
- **Footer**: plain `SidebarRow`s "Add project" (plus) and "Settings" (gear at 1.15 scale); padding 10 at the sides and 12 below. A small update dot sits on the gear. No divider above it.
- **Empty search**: "No results" at 13/600, label 0.92; hint at 11 secondary; padding 8 at the sides and 14 above.

### 5.3 Chat timeline (`Views/Chat/ThreadTimeline.swift`, `TimelineRows.swift`)

- **Column**: max width 820, centred, padding 20 at the sides. Top padding is 72 (the chrome row plus 28 of breathing room); bottom 18. Rows are 20 apart. A short thread sits at the bottom of the pane. There is no scrollbar.
- **Older history** loads automatically near the top. The manual pill reads "Show N earlier messages": 12 secondary, padding 14/7, capsule fill `.quaternary .5`.
- **User message** (`UserMessageRow`):
  - Right-aligned, with at least 96 of leading inset.
  - Bubble: radius 18 with a 4px iMessage tail at the bottom-right (`UserBubble`). Padding 14 on the leading side, 14+4 on the trailing side, 9 vertically. Text 13 in the label colour.
  - **Fill**: Droppy uses accent 14 %; ViewCode default is accent 12 % dark (`#312923`) / 10 % light (`#F0EAE3`). The tail is optional for ViewCode (a plain 18 radius is fine).
  - Attachments sit above as 56px thumbnails, radius 12, 6 apart. Files are 10px chips, radius 10.
  - A hover line below holds revert and copy at 22×22 in secondary, faded in. It sits in the 20px gap and does not add height.
  - **There is no "You" heading.**
- **Assistant message**: unboxed markdown (§2.4) with no heading, avatar or background. The hover line holds, trailing, the turn summary (10 tertiary) and a copy button. Blocks are 12 apart; list items 6 apart with an 8px marker gap.
- **Markdown blocks**:
  - Code block: fill `.quaternary .45`, radius 12, **no border**. Padding 12 at the sides, 4 above and 12 below; the header (language and copy) shows on hover.
  - Table: fill `.quaternary .35`, radius 12, padding 12, semibold header, body text at label 0.9.
  - Blockquote: a 3px capsule bar in `.quaternary` and secondary text, gap 10.
  - Rule: 1px `.quaternary`, 4px vertical padding.
  - Bullets: 5px accent dots at 0.9; nested levels use a 5.5px ring with a 1.2px stroke.
- **Tool row** (`ToolRow`):
  - One line: a 16px icon column (10px glyph, secondary), 8 gap, then the label (12 secondary, truncated in the middle).
  - Then optional diff stats (+green/−red, 10 tabular), then a chevron (10/600 tertiary; right-pointing, rotated 90° when open, or down-pointing for popovers).
  - Trailing: `exit N` in danger or "Declined" in warning.
  - **No card, border or background.** A running tool shows a mini progress spinner in the icon column.
  - Expanded output: mono 10 secondary, 12 lines at most, in blocks filled `.quaternary .45`, radius 10, padding 10.
- **Work group** (`WorkGroup`, `WorkSteps`):
  - A summary line ("Edited files, ran commands") with the same anatomy and a chevron.
  - It starts collapsed once reply text follows it. Open, it shows the last 2 steps plus an "N earlier steps" line with an ellipsis icon.
- **Working indicator** (`WorkingIndicator`):
  - One line with the spinner in the 16 column, then a rotating word + "…" (changes every 7s; the word list is in `WorkingWords`) or the live tool summary, then the elapsed time (tabular), all 12 secondary, then a tertiary chevron.
  - The chevron opens the thinking (12, dimmed) and the live steps, indented 24.
- **Turn finished** (`TurnFinishedBlock`):
  - The header "Worked for 1m 12s" (12 secondary) with a chevron.
  - Then a divider at 0.6 opacity, 10 above and below.
  - Then the answer.
  - Then the **file card** (`TurnFileCard`):
    - Fill `.quaternary .32`, radius 14.
    - Header row, padding 12/10: a 36×36 icon tile (radius 10, fill `L(.08)`, 15px glyph secondary), "Edited N files" at 12/500 with diff stats beneath, then Undo (12 secondary) and a glass "Review" button.
    - Divider at 0.5, then one row per file (12, padding 12/7, stats trailing).
- **Plan card**: accent 6 % fill, radius 18, padding 16; headline title with an accent icon.
- **Todo list**: `.quaternary .3`, radius 14, padding 14, rows 7 apart. Done items show a filled accent check; pending items a tertiary circle.
- **Notice**: info is plain secondary text. Warning is orange 10 % and error red 10 % fill, radius 12, padding 12/9.
- **Approval card** (`Composer/RequestCards.swift`): padding 16; glass tinted `orange .10`, radius 20; headline title; command block `.quaternary .5`, radius 10, padding 10; a glass-prominent Approve button next to glass buttons.
- **Jump-to-latest**: a 32 glass circle with a down arrow, floating 10 above the composer.

### 5.4 Working indicators (`Views/Common/WorkingIndicators.swift`)

| Indicator                     | Anatomy                                                                                      | Colour                                                                                  | Motion                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkingSpinner` (timeline)   | 3×3 square cells, cell 3.5, gap 2.8 (0.8×cell), side ≈16                                     | row 0: accent mixed with 38 % white; row 1: accent; row 2: accent mixed with 22 % black | each cell's opacity follows `GradientSpin.opacity`: fade 1→0.1 over 45 % of the period (smoothstep), hold 0.1 until 92 %, rise back to 1. **Period 0.75s.** Lag per cell = distance from bottom-centre ÷ 2.5, so the wave rises. |
| `MiniSpinner` (sidebar badge) | 2 columns × 3 rows, cell 2.4                                                                 | same tints                                                                              | lag = position around the perimeter ÷ 6, clockwise                                                                                                                                                                               |
| `ComposerWorkingDots`         | 2px dots on an 8px pitch, 3 rows at most, in the bottom 40 % of the composer behind the text | accent                                                                                  | pulse 2.2s, column delay 0.045, row delay 0.09                                                                                                                                                                                   |

ViewCode rules:

- Port the spinner, but drive it with **stepped CSS keyframes** (`steps(n)`, at most 12 distinct frames per period) on `opacity` only, and pause it when it is off screen (`--visible-animation-state`), like the existing `--animate-status-pulse`.
- **Do not port `ComposerWorkingDots`.** It is a full-width continuous field; the anti-goal is in §7.
- Reduced motion: static cells at their phase-0 opacity.

### 5.5 Composer (`Views/Composer/ComposerView.swift`)

- **Area**: max width 820, padding 20 at the sides and 14 below, centred. Approval cards and tabs stack above it, 12 apart.
- **Pill**:
  - Glass `regular`, **radius 22** (continuous). Padding 14 on the leading side, 8 trailing, 8 vertical; the text column has 4 more vertically.
  - An empty pill is **44 tall**. The text is 14px and grows up to 5 lines, with its height animated over 280ms.
  - Droppy has no focus ring. **ViewCode default:** while focused, the hairline turns accent 60 % with a 3px accent 14 % ring, so the composer reads as the live surface.
  - ViewCode web: `--vc-sheet` at 72 % with blur and a hairline `L(0.10)` (§3.1). Replace `rounded-3xl` (24px) with 22.
- **Controls** sit on the pill's bottom line, trailing, 2 apart, in this order:
  1. the paperclip chip;
  2. the model/effort chip;
  3. the context ring;
  4. the send button.
- **Chip** (`ChipButtonStyle`):
  - 12px, padding 9/5, capsule, secondary text, no border.
  - Hover `primary .07`, pressed `.12`.
  - Active: text in the accent over a 16 % accent fill (26 % pressed).
- **Model chip** (`EffortSlider.swift :: ModelEffortButton`): the 14px provider icon, 5 gap, the model's short name in label, the effort title at label 0.72, and an 8px bold chevron in secondary. It reads "Select effort" while its popover is open. Fast mode adds an 11px yellow bolt.
- **Context ring** (`ContextMeter`): 15px circle with a 2.5 stroke. Track `.quaternary`; progress in the accent, orange above 85 %; round caps, starting at −90°. Padding 6/5.
- **Send button** (`SendButton`):
  - A 28px circle with a 12/600 arrow-up glyph, turning into a stop square while running.
  - Enabled: accent fill (Droppy). ViewCode default: the same, with a dark glyph on the dark-mode amber.
  - Disabled: `.quaternary` fill.
  - 4px extra gap before it.
- **Draft attachments**: 48px thumbnails at the top of the pill; the remove badge is white on `black .6`, offset (6, −6).
- **Changes tab** (`ThreadChangesTab`):
  - Sits on the pill's top edge, overlapping it by 14. Glass, with only the top corners rounded (12).
  - Padding 12 at the sides, 7 above, 7+14 below. Text 12/500 tabular.
  - Contents: a secondary ± glyph, then "N files" at label 0.9, then `+N` in `#5CD680` and `−N` in `#F26B6B`. In ViewCode, use the success and danger tokens instead.
  - The question tab and the queued follow-ups take the same slot.
- **Suggestions** (`/`, `@`): an anchored popover (§5.6) with a header "Commands"/"Files", rows 26 tall, and a selected/hover fill of `L(0.10)`.

### 5.6 Popovers and menus (`Views/Chrome/Popovers.swift`)

- **Container**: a native popover with an arrow; on the web, base-ui popover positioned below the anchor. Minimum width 210, maximum 360, maximum height 460 (scrolls). Padding 6.
  - Web material: `dropdown-glass` with `--popover` = `#2C2C2E` at 90 % plus blur 24 (dark), or `#F7F7F8` at 90 % (light).
  - Hairline `L(0.10)`. Radius 12. Shadow at most `0 8px 24px rgb(0 0 0/.28)` dark and `/.12` light.
- **Item** (`PopoverItem`):
  - 26 tall, radius 6, padding 8 at the sides, gap 8.
  - Optional check column of 14 (11/600 check, kept for every row of a choice list).
  - 16px icon or logo, then the title (13, truncated in the middle), a spacer of at least 16, then the detail (12 secondary).
  - Hover `L(0.10)`. Destructive rows use the danger colour for text and icon. Disabled rows are at 0.4 opacity.
- **Section header**: 11/600 secondary, padding 8 at the sides, 6 above, 3 below.
- **Note**: 12 secondary, padding 8/5.
- **Divider**: `separatorColor`, padding 8 at the sides and 5 vertically.
- **Delete confirmation**: an inline popover on the row, 280 wide: header, note, divider, red rows.
- **Command palette** (`Views/Palette/CommandPalette.swift`):
  - 600 wide, 72 from the top, glass, radius 24, over a scrim of `black .06`.
  - Field row: padding 18/15, 15px text, magnifier.
  - Result rows: padding 12/8, radius 12, 18px icon, 10px secondary detail. The selected row is filled with accent 16 %. ViewCode default: `L(0.10)`, neutral.

### 5.7 Settings (`Views/Settings/SettingsView.swift`)

- **Frame**: in Droppy, Settings is its own fixed 780×580 window with the same backdrop. It has a 212 sidebar (traffic-light clearance, search field, `SidebarRow`s with plain 14px glyphs, **no coloured icon tiles**), and the page sits on the detail sheet.
- **Page**:
  - Padding 24 at the sides, 22 above (or 60 when the page has chrome controls), 24 below. Sections are 20 apart.
  - Floating chrome at the top holds the compact title (15/600, fades in on scroll) and page accessories as capsules (the model search field is a 200 wide capsule).
- **Section**: title 13/600 secondary, then the card 10 below.
- **Card** (`ChromeCard`): fill `L(0.03)`, radius 16, **no border and no shadow**.
- **Row** (`ChromeRow`):
  - Padding 16 on the leading side, 10 trailing, 11 vertically; 16 gap between text and control.
  - Title 13 label; optional detail 11 secondary, 2 below.
  - The control is trailing: a small system switch (accent when on), or a glass picker capsule (32 tall, 12.5/500, 14px logo or swatch, 8px chevron) that opens a popover list.
- **Row divider**: a 1px separator inset 16 from the leading edge.
- **Empty archive**: a single 44px light archive glyph in secondary at 0.6.
- ViewCode keeps its own settings navigation and pages. It adopts the card, row and section anatomy above, and the theme picker with swatches.

### 5.8 Terminal and other opaque surfaces

The terminal is the one deliberately opaque surface: dark `#141414` (white 0.08), light `#FBFBFB` (0.985). Its header is 38 tall with 12px glyphs. Tabs are capsules at 12, padding 10/5, with the selected tab filled `primary .08`. It slides up from the bottom inside the sheet.

---

## 6. Mapping to ViewCode

### 6.1 Implementation constraints (upstream-friendly)

ViewCode tracks upstream T3 Code. The re-theme must keep future merges cheap.

1. **Tokens first.** Change `VIEWCODE_THEME` in `packages/shared/src/themePalettes.ts`; it is ViewCode-owned. Add new ViewCode tokens in a new CSS file before touching any component. Most of the look must come from palette values.
2. **One new stylesheet.** Create `apps/web/src/viewcode-theme.css` (V). Import it once, as the **last** import at the end of `apps/web/src/index.css` (a one-line upstream edit). Scope every rule to `html[data-theme-id="viewcode"]` or to a ported theme id, so upstream themes render unchanged.
   - Specificity trap: the base mapping block is `html[data-theme-id]:not([data-theme-id=""])`, which is (0,2,1). A bare `html[data-theme-id="viewcode"]` is (0,1,1) and **loses**. Use `html[data-theme-id="viewcode"]:not([data-theme-id=""])`, or rely on equal specificity plus the later import.
   - Chat-header control rules are (0,3,1). Match them with the same selector shape.
3. **Theme colour format.** Palette values must be literal CSS colours that culori can parse (`#hex`, `rgb(... / a)`, `oklch(...)`); alpha is allowed. **No `var()` or `color-mix()`** in palette entries; put those in `viewcode-theme.css`. Use opaque values for any role that text sits on (surface, surfaceOverlay, messageSurface, sidebar, canvas). Alpha is fine for overlays and borders.
4. **Variants over restyles.** Where a component needs a new look, add a `variant` to the `components/ui` primitive; `shadcn/no-restyle` forbids className restyles. If the look belongs to one feature, put it in a ViewCode wrapper component.
5. **Hard-coded colour classes.** Replace a class with the nearest _semantic_ token class (`text-indigo-600 dark:text-indigo-300/90` becomes `text-info-foreground`, for example) so the diff is one line and matches the direction upstream is heading. Do not replace them with a ViewCode-specific class. Leave brand or identity colours alone (provider logos, GitHub merged purple, file-type icons, project icon colours).
6. **New themes live in a new module.** Put the ported themes in `packages/shared/src/viewcodeThemes.ts` (V) and spread them into `WEB_BUILT_IN_THEMES`, which is already a ViewCode edit. Don't interleave them with upstream theme constants.
7. **Desktop.** Put vibrancy and material options behind one ViewCode helper in `apps/desktop/src/window/` (V), called from `DesktopWindow.ts` with a one-line change (U).
8. **Minimise U rows.** Every U row below should be a one-line class swap, or have a documented reason.

### 6.2 Mapping table

| #   | ViewCode target                                                                                                                      | Current                                                                                         | Target (ViewCode default; Droppy reference in brackets)                                                                                                                                                                                                                                                                       | Kind                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `VIEWCODE_THEME.colors` (dark), `themePalettes.ts`                                                                                   | violet, `oklch(... 300)` accent and bubble                                                      | the full role table in §6.3                                                                                                                                                                                                                                                                                                   | T                                                  |
| 2   | `VIEWCODE_THEME.variants.light`                                                                                                      | `IRIS_THEME.colors` (violet)                                                                    | the light role table in §6.3                                                                                                                                                                                                                                                                                                  | T                                                  |
| 3   | `VIEWCODE_THEME.appearance` / preference                                                                                             | dark first                                                                                      | follow the system (`useTheme.ts` default already `viewcode`; keep the mode "system")                                                                                                                                                                                                                                          | T                                                  |
| 4   | Ported themes                                                                                                                        | none                                                                                            | `viewcodeThemes.ts`: at least `claude` (dark, variant light = claudeLight); optionally the rest of §4 through the §6.3 derivation                                                                                                                                                                                             | V                                                  |
| 5   | `--glass-blur/opacity/saturation`                                                                                                    | 12–16px / 80 % / 1.08–1.14                                                                      | 24px dark, 20px light / 72 % / 1.6 (`viewcode-theme.css`)                                                                                                                                                                                                                                                                     | V                                                  |
| 6   | Window/sheet planes                                                                                                                  | `bg-background` everywhere, sidebar `bg-sidebar` with a border                                  | sidebar and chrome = `--vc-window`; main pane = inset sheet (margin 10, radius 16, `--vc-sheet`). The sidebar component already has a `variant="inset"` path (`ui/sidebar.tsx`, `md:peer-data-[variant=inset]:m-2 rounded-xl`); select it for the viewcode theme and override margin 10 and radius 16 in `viewcode-theme.css` | T + V (one variant prop at the call site: U)       |
| 7   | Sidebar border (`index.css` `html[data-theme-id] [data-app-sidebar]` border-color 8–10 %)                                            | visible hairline                                                                                | `border-color: transparent` for viewcode                                                                                                                                                                                                                                                                                      | V                                                  |
| 8   | `surface-grain` noise                                                                                                                | 3.5 % noise on body and sidebar                                                                 | `--surface-grain: none` for viewcode (Droppy has no texture)                                                                                                                                                                                                                                                                  | V                                                  |
| 9   | Sidebar menu button (`ui/sidebar.tsx` `sidebarMenuButtonVariants`)                                                                   | h-8 (32), radius `--control-radius` 8, `text-sm` 14                                             | height 28, radius 7, padding 8, `text-row` 13, selected weight 500. Set it with `--control-radius: 7px`, `--sidebar-row-content-inset: 8px`; for height add a `size="compact"` variant (28px)                                                                                                                                 | T + U (variant)                                    |
| 10  | Sidebar row colours                                                                                                                  | `--sidebar-row-*` roles                                                                         | hover `L(.06)`, active `L(.10)`, selected `L(.12)`; palette alphas in §6.3                                                                                                                                                                                                                                                    | T                                                  |
| 11  | Sidebar icon colour `--sidebar-icon-color`                                                                                           | muted mix at 60 %                                                                               | label 0.85: dark `#C8C8C9`, light `#3A3A3A` (V override)                                                                                                                                                                                                                                                                      | V                                                  |
| 12  | Sidebar status pills, `components/Sidebar.logic.ts` ~L993–1050                                                                       | `indigo-*` (Awaiting Input), `sky-*` (Working, Connecting, Monitoring), `violet-*` (Plan Ready) | Awaiting Input → `text-warning-foreground` / `bg-warning` (Droppy: orange hand); Working, Connecting and Monitoring → `text-muted-foreground` / `bg-muted-foreground`, with the mini-spinner as the working mark; Plan Ready → `text-foreground` / `bg-foreground` (neutral)                                                  | U (one-line class swaps)                           |
| 13  | User bubble, `MessagesTimeline.tsx` ~L2133 (`rounded-2xl bg-message p-3` + `MessageAuthorHeading "You"`)                             | violet `messageSurface`, 16 radius, 12 padding, "You" label                                     | colour: `messageSurface` token (T). Shape: radius 18, padding 9/14 (add a `.vc-user-bubble` class via a `data-` attribute rather than restyling). Hide the "You" heading (`MessageAuthorHeading`) for viewcode: add a `data-slot` to it and hide it in `viewcode-theme.css`                                                   | T + U                                              |
| 14  | Send / primary action, `ComposerPrimaryActions.tsx` (`bg-message-action ... shadow-message-action/24`) and `ChatComposer.tsx` ~L6461 | violet, 32px                                                                                    | colour via the `messageAction*` roles (T). Size 28px (`size-7`); drop the coloured shadow (`shadow-message-action/24` becomes nothing)                                                                                                                                                                                        | T + U                                              |
| 15  | Composer shell, `chat/ComposerSurface.tsx`                                                                                           | `rounded-3xl` (24), outline `--app-theme-toolbar-border`, `shadow-composer`                     | radius 22; outline `L(.10)`; no drop shadow in dark, at most `0 1px 2px rgb(0 0 0/.08)` in light; glass from row 5. Set `--chat-composer-*` variables for viewcode in `viewcode-theme.css`; the radius needs a CSS override `[data-slot=composer-shell]::before{border-radius:22px}`                                          | V (prefer) / U                                     |
| 16  | `--shadow-composer(-dark)`                                                                                                           | `0 12px 28px -18px /40 %`, `/75 %`                                                              | `0 1px 2px rgb(0 0 0/.08)` / `none`                                                                                                                                                                                                                                                                                           | V                                                  |
| 17  | Effort ramp `--effort-low/high` (`index.css`)                                                                                        | sky `#7dd3fc` → blue `#1d4ed8`                                                                  | accent (solid): both set to `var(--app-theme-accent)` for viewcode (Droppy `TrackLook.plain`)                                                                                                                                                                                                                                 | V                                                  |
| 18  | `--primary` (unthemed fallback)                                                                                                      | `oklch(0.488 0.217 264)` blue                                                                   | unchanged (only upstream themes use it)                                                                                                                                                                                                                                                                                       | none                                               |
| 19  | `--success` / `--info` (not theme roles)                                                                                             | emerald / blue-500                                                                              | success `#5BB98B` / `#2E8B57`; info = accent. Diff foregrounds (`--diff-addition-foreground`) follow success and danger                                                                                                                                                                                                       | V                                                  |
| 20  | GitHub alert callouts, `ChatMarkdown.tsx` ~L524–537                                                                                  | `border-blue-500/70 text-blue-600`, `border-purple-500/70 text-purple-600`                      | NOTE → `border-info/70 text-info-foreground`; IMPORTANT → `border-foreground/40 text-foreground` (neutral; GitHub purple is not load-bearing)                                                                                                                                                                                 | U                                                  |
| 21  | `ContextChip.tsx` kinds `review-comment` 292, `pull-request` 277, `skill` 322, `citation` 259 (oklch hue)                            | violet/indigo chip accents                                                                      | review-comment, citation and pull-request → `oklch(0.62 0.02 259)` (neutral slate); skill → keep. `pr-merged` 292 is GitHub identity: keep                                                                                                                                                                                    | U                                                  |
| 22  | `ui/standalone-page.tsx` radial `blue-500` / `sky-500` glow                                                                          | coloured radial glow                                                                            | remove for viewcode (`[data-theme-id=viewcode] .standalone-glow{display:none}`), or swap to `var(--accent)` at 6 %                                                                                                                                                                                                            | V (via data-slot) / U                              |
| 23  | `auth/AuthSurfaceShell.tsx` header `linear-gradient(135deg,#1e61de,#17348e)` + radial `rgba(136,204,255,.5)`                         | saturated blue gradient banner                                                                  | T3 Connect brand surface; keep upstream, or for viewcode override with `--vc-window` and a hairline. Low priority                                                                                                                                                                                                             | U (skip if possible)                               |
| 24  | `pullRequest/pullRequestIcons.tsx`, `PullRequestThreadDialog.tsx` `violet-600`                                                       | merged PR                                                                                       | GitHub identity: keep                                                                                                                                                                                                                                                                                                         | none                                               |
| 25  | `settings/ResourceTelemetryDiagnostics.tsx` `bg-violet-500`                                                                          | chart category                                                                                  | keep (categorical data colour)                                                                                                                                                                                                                                                                                                | none                                               |
| 26  | `projectIconColors.ts` (18 hues)                                                                                                     | identity colours                                                                                | keep; Droppy's glyphs are monochrome, so optionally render project icons monochrome at label 0.85 for viewcode                                                                                                                                                                                                                | V (optional)                                       |
| 27  | `SidebarStageBackdrop.tsx` (viewcode → "pill")                                                                                       | artwork/pill backdrop                                                                           | none for viewcode (no artwork; glass only)                                                                                                                                                                                                                                                                                    | U (one line)                                       |
| 28  | Chat header `[data-chat-header]` controls (`index.css` L1348+)                                                                       | `toolbar-control` filled, bordered buttons                                                      | Droppy capsules: 32 tall, glass `--vc-sheet`@72 % + blur, no border (hairline `L(.08)`), grouped into capsules with 1×14 dividers `L(.19)`. `toolbarControl` = `rgb(255 255 255/.07)`, hover `/.11`, `toolbarBorder` = `/.06`                                                                                                 | T (+ V for radius/height)                          |
| 29  | Markdown code (`.chat-markdown`)                                                                                                     | code tokens with border                                                                         | fill `.quaternary .45` (dark `#232325`, light `#F2F2F3`), radius 12, **no border**; inline code: no background, mono 12                                                                                                                                                                                                       | T + V                                              |
| 30  | Tool rows / work log (`MessagesTimeline.tsx`)                                                                                        | existing                                                                                        | already one-line; check it uses 12px secondary text, a 16px icon column and 20px row rhythm. Keep `live-tool-shine` (upstream, stepped, paused off-screen)                                                                                                                                                                    | V (spacing)                                        |
| 31  | Popovers/menus (`ui/menu.tsx`, `ui/popover.tsx`, `dropdown-glass`)                                                                   | 10 % border, glass 80 %                                                                         | item 26px tall, radius 6, hover `L(.10)`, popover radius 12, section header 11/600 secondary; via `--control-radius` and viewcode overrides                                                                                                                                                                                   | T + V                                              |
| 32  | Settings cards (`settings/*`)                                                                                                        | bordered cards                                                                                  | fill `L(.03)`, radius 16, no border; rows 16/10/11; section titles 13/600 secondary                                                                                                                                                                                                                                           | V (selector on the existing settings `data-slot`s) |
| 33  | Electron `getInitialWindowBackgroundColor`, window options                                                                           | `#0a0a0a` / `#ffffff`, opaque                                                                   | §3.2 values and vibrancy/material helper                                                                                                                                                                                                                                                                                      | V + U (one line)                                   |
| 34  | Theme picker swatches (`settings/Theme*`)                                                                                            | cards                                                                                           | a gradient swatch per §4 (surface 0–42 % → accent), 14px in rows and 16px in the menu                                                                                                                                                                                                                                         | U (optional)                                       |

### 6.3 Role tables

**ViewCode default: dark** (`VIEWCODE_THEME.colors`)

| Role                     | Value                     | Role                    | Value                     |
| ------------------------ | ------------------------- | ----------------------- | ------------------------- |
| canvas                   | `#19191B`                 | chrome                  | `#1F1F21`                 |
| toolbar                  | `#19191B`                 | toolbarForeground       | `#DEDEDF`                 |
| toolbarBorder            | `rgb(255 255 255 / 0.06)` | toolbarControl          | `rgb(255 255 255 / 0.07)` |
| toolbarControlForeground | `#E6E6E7`                 | toolbarControlHover     | `rgb(255 255 255 / 0.11)` |
| surface                  | `#19191B`                 | surfaceRaised           | `#242426`                 |
| surfaceOverlay           | `#2C2C2E`                 | text                    | `#DEDEDF`                 |
| textMuted                | `#999999`                 | border                  | `rgb(255 255 255 / 0.08)` |
| input                    | `rgb(255 255 255 / 0.12)` | focus                   | `#E0A15A`                 |
| accent                   | `#E0A15A`                 | accentForeground        | `#1A1206`                 |
| secondary                | `rgb(255 255 255 / 0.06)` | secondaryForeground     | `#DEDEDF`                 |
| muted                    | `rgb(255 255 255 / 0.04)` | mutedForeground         | `#999999`                 |
| placeholder              | `#6B6B6C`                 | secondaryLabel          | `#999999`                 |
| iconMuted                | `#8A8A8C`                 | error                   | `#E5675F`                 |
| errorForeground          | `#F08A83`                 | errorSurface            | `rgb(229 103 95 / 0.12)`  |
| warning                  | `#C9B037`                 | warningForeground       | `#DCC86A`                 |
| warningSurface           | `rgb(201 176 55 / 0.12)`  | update                  | `#E0A15A`                 |
| updateForeground         | `#EDBE84`                 | updateSurface           | `rgb(224 161 90 / 0.14)`  |
| accentSurface            | `rgb(255 255 255 / 0.06)` | accentSurfaceForeground | `#DEDEDF`                 |
| messageSurface           | `#2A2A2C`                 | messageForeground       | `#DEDEDF`                 |
| messageAction            | `#E8E8EA`                 | messageActionForeground | `#1C1C1E`                 |
| messageActionHover       | `#FFFFFF`                 | codeBackground          | `#232325`                 |
| codeForeground           | `#DEDEDF`                 | sidebar                 | `#1F1F21`                 |
| sidebarForeground        | `#DEDEDF`                 | sidebarMutedForeground  | `#9A9A9B`                 |
| sidebarControlSurface    | `rgb(255 255 255 / 0.06)` | sidebarRowHover         | `rgb(255 255 255 / 0.05)` |
| sidebarRowActive         | `rgb(255 255 255 / 0.08)` | sidebarRowSelected      | `rgb(255 255 255 / 0.10)` |
| sidebarBorder            | `rgb(255 255 255 / 0)`    | terminalBackground      | `#141414`                 |
| terminalForeground       | `#DEDEDF`                 | terminalCursor          | `#E0A15A`                 |
| terminalSelection        | `rgb(138 162 196 / 0.28)` | terminalScrollbar       | `rgb(255 255 255 / 0.12)` |
| terminalScrollbarHover   | `rgb(255 255 255 / 0.20)` |                         |                           |

**ViewCode default: light** (`VIEWCODE_THEME.variants.light`)

| Role                     | Value                   | Role                    | Value                   |
| ------------------------ | ----------------------- | ----------------------- | ----------------------- |
| canvas                   | `#FAFAFA`               | chrome                  | `#EDEDEF`               |
| toolbar                  | `#FAFAFA`               | toolbarForeground       | `#262626`               |
| toolbarBorder            | `rgb(0 0 0 / 0.06)`     | toolbarControl          | `#FFFFFF`               |
| toolbarControlForeground | `#2E2E2E`               | toolbarControlHover     | `#F2F2F3`               |
| surface                  | `#FAFAFA`               | surfaceRaised           | `#FFFFFF`               |
| surfaceOverlay           | `#F7F7F8`               | text                    | `#262626`               |
| textMuted                | `#7D7D7D`               | border                  | `rgb(0 0 0 / 0.08)`     |
| input                    | `rgb(0 0 0 / 0.12)`     | focus                   | `#9A5714`               |
| accent                   | `#9A5714`               | accentForeground        | `#FFFFFF`               |
| secondary                | `rgb(0 0 0 / 0.04)`     | secondaryForeground     | `#262626`               |
| muted                    | `rgb(0 0 0 / 0.03)`     | mutedForeground         | `#7D7D7D`               |
| placeholder              | `#A0A0A0`               | secondaryLabel          | `#7D7D7D`               |
| iconMuted                | `#8C8C8C`               | error                   | `#C4392F`               |
| errorForeground          | `#B3261E`               | errorSurface            | `rgb(196 57 47 / 0.08)` |
| warning                  | `#7E6A00`               | warningForeground       | `#6B5A00`               |
| warningSurface           | `rgb(126 106 0 / 0.10)` | update                  | `#9A5714`               |
| updateForeground         | `#9A5714`               | updateSurface           | `rgb(154 87 20 / 0.10)` |
| accentSurface            | `rgb(0 0 0 / 0.05)`     | accentSurfaceForeground | `#262626`               |
| messageSurface           | `#EDEDEF`               | messageForeground       | `#262626`               |
| messageAction            | `#1D1D1F`               | messageActionForeground | `#FFFFFF`               |
| messageActionHover       | `#3A3A3C`               | codeBackground          | `#F2F2F3`               |
| codeForeground           | `#262626`               | sidebar                 | `#EDEDEF`               |
| sidebarForeground        | `#262626`               | sidebarMutedForeground  | `#7A7A7C`               |
| sidebarControlSurface    | `rgb(0 0 0 / 0.06)`     | sidebarRowHover         | `rgb(0 0 0 / 0.05)`     |
| sidebarRowActive         | `rgb(0 0 0 / 0.08)`     | sidebarRowSelected      | `rgb(0 0 0 / 0.10)`     |
| sidebarBorder            | `rgb(0 0 0 / 0)`        | terminalBackground      | `#FBFBFB`               |
| terminalForeground       | `#262626`               | terminalCursor          | `#9A5714`               |
| terminalSelection        | `rgb(62 92 136 / 0.18)` | terminalScrollbar       | `rgb(0 0 0 / 0.14)`     |
| terminalScrollbarHover   | `rgb(0 0 0 / 0.22)`     |                         |                         |

**Derivation for ported Droppy themes** (in `viewcodeThemes.ts`; compute the values in TS once and store them as literals). Start from the default table of the same scheme and change only these roles:

| Role                                                | Formula                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| chrome, sidebar                                     | `mix(surface 35 %, #1F1F21)` dark / `mix(surface 35 %, #ECECEE)` light                                                    |
| canvas, surface, toolbar                            | `mix(surface 55 %, #18181A)` dark / `mix(surface 55 %, #F7F7F8)` light                                                    |
| surfaceRaised / surfaceOverlay / codeBackground     | canvas mixed with white 5 % / chrome mixed with white 6 % / canvas mixed with white 4.5 % (light: mixed with black 4.5 %) |
| accent, focus, update, terminalCursor               | theme accent (or `#0A84FF` dark / `#007AFF` light for Droppy's system/light/dark)                                         |
| accentForeground, messageActionForeground           | `#FFFFFF` when the accent's OKLCH L < 0.72, else `#101010`                                                                |
| messageAction                                       | accent (Droppy fidelity); messageActionHover = accent mixed with white 10 %                                               |
| messageSurface                                      | `mix(accent 14 %, canvas)`                                                                                                |
| updateSurface / terminalSelection                   | accent at 14 % / 28 % (dark), 10 % / 18 % (light)                                                                         |
| error, errorForeground / warning, warningForeground | danger / warning (foreground = the same hue mixed with white 20 % in dark, black 15 % in light)                           |
| success (V variable, not a role)                    | theme success                                                                                                             |

Precomputed **Claude** (dark): chrome/sidebar `#1D1D1D`; canvas/surface `#191818`; surfaceRaised `#242424`; surfaceOverlay `#2B2B2B`; codeBackground `#232222`; accent `#C15F3C`; accentForeground `#FFFFFF`; messageAction `#C15F3C`; messageActionHover `#C76F50`; messageSurface `#31221D`; error `#D97757`; warning `#C9A227`; success `#51A556`.

Precomputed **Claude Light**: chrome/sidebar `#F1F1F0`; canvas/surface `#F9F8F6`; codeBackground `#EEEDEB`; accent `#C15F3C`; messageSurface `#F1E3DC`; error `#B3261E`; warning `#9A6700`; success `#2E7D32`. Everything else comes from the light default table.

---

## 7. Acceptance criteria and anti-goals

Review from screenshots of the main window: an empty thread, a thread with a user message, reply, tool rows and a finished-turn file card, an open model/effort popover, the sidebar with one selected and one running thread, and a Settings page. Take each one in **dark and light**, with the **ViewCode default** theme and the **Claude** theme. The standard is "professional and restrained, in the spirit of Droppy", not pixel-matching.

Acceptance:

1. There is no purple, violet or indigo anywhere in the default theme (dark or light) except provider or brand logos and GitHub's merged-PR state.
2. The accent is used on these elements only: links and citations, list markers, the unread dot, an active chip, the context ring, the focus ring and focused composer, the plain effort track, the working indicator, switches and primary actions (the send button), the user bubble tint, the open sidebar thread, and tool-row icons on hover or while expanded. Hovers, headers, tool text, cards and borders are neutral.
3. There are two planes: the sidebar on the window colour with no border line, and the content on an inset rounded sheet (inset ≈10, radius ≈16). You can tell them apart by tone alone (dark `#1F1F21` vs `#19191B`; light `#EDEDEF` vs `#FAFAFA`).
4. The text hierarchy is visibly three-step: primary, secondary (~55 %), tertiary chevrons (~25 %). No text colour carries a hue except links and status.
5. Sidebar rows are 28 tall, radius ~7, 13px titles. Selection is a soft neutral fill (≈10 % label). Trailing times are 11px tabular.
6. The chat header is floating capsules and circles (32 tall) over the content, with no full-width bar or bottom border. Content scrolls under a soft veil.
7. The transcript: the user message is a right-aligned rounded bubble (radius ~18) with no "You" label. The assistant reply is unboxed. Tool rows are single secondary-text lines with a 16px icon column and no cards. Rows are ~20px apart.
8. The composer is one glass pill, radius ~22, 44 tall when empty, with a neutral hairline that turns accent while focused and no glow. The chips are borderless. The send button is 28px, the accent when there is a draft and neutral when empty.
9. Popovers and menus have 26px rows, a hover fill of ~8–10 % label, 11px semibold section headers and a hairline border only.
10. Settings cards are borderless, filled at ~3 % label, radius 16, with 11px secondary detail lines.
11. Claude theme: the accent is terracotta `#C15F3C` on the elements in item 2 plus the send button and bubble (14 %). The surfaces are warm-neutral near-greys, not brown slabs. Status colours come from the Claude row in §4.
12. On desktop macOS, with vibrancy on, the wallpaper faintly shows through the sidebar area. With it off, the §3.1 colours appear with no white or black flash on launch.

Anti-goals (reject if seen):

- Purple, indigo or blue **gradients** anywhere in the default theme: backgrounds, banners, buttons, headers or radial glows.
- **Opaque slabs**: sidebar or header bars painted in a different solid colour with borders between them; cards inside cards; filled message boxes for assistant replies.
- **Glowing or coloured shadows** (`shadow-primary/24`, `shadow-message-action/24`, coloured `box-shadow` halos, focus glows). Shadows are neutral and small, if present at all.
- Accent-coloured sidebar selection, accent borders, accent section titles, or accent icons at rest.
- Bordered code blocks with accent tint; inline code with coloured pills.
- **Continuous animations.** The effort-slider exception documented in `docs/internals/viewcode.md` is the only one. The working spinner runs only while a turn runs, is stepped and pauses off-screen; the existing upstream `live-tool-shine` and status pulses are allowed. No composer dot fields, animated gradients, shimmer backgrounds or `blur` transitions.
- Large type in the chrome (anything above 15px outside empty states) and heavy (700) weights outside H3.
- Surface grain, noise textures or artwork on the default theme.
