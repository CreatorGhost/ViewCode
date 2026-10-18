> Reference-only orphan branch. Never merge this branch into a product branch. Videos and repository code are intentionally excluded.

# Zeron vs ViewCode: motion and responsiveness audit

## Executive findings

**The strongest finding is inconsistent motion: ViewCode snaps panels and the terminal into place, yet animates the command palette for about200ms. Zeron animates panel movement and makes its palette immediate.** The audit ended after the core findings; the coverage table records the remaining unmeasured scenarios.

- **Panel motion is the clearest feel difference.** ViewCode defaults panel animation to0ms and usually changes in a single crop; Zeron reveals/closes panes and terminal through many crops. Sidebar first-change medians are close, so its central observed issue is design continuity, not demonstrated slower input onset. Zeron's source uses 180–240ms pane motion and 200ms terminal motion; adding such a transition would not make ViewCode 200ms faster.
- **Palette has the opposite design imbalance.** In the accepted caret-free ROI, ViewCode open first changes at 59.260–59.296ms versus Zeron 33.724–33.732ms, then continues through an extended entrance/exit. This supports investigating both immediacy and motion pacing; it does not isolate layout/React/focus as the cause.
- **Editor glyph timing is not a universal native win.** In a 4×12px interior crop, insertion first appears sooner in Zeron's cohort, undo disappearance sooner in ViewCode's. Zeron's later second crop change remains unassigned and is not whole-editor settling.
- **One file-open pilot reveals a layout continuity issue.** ViewCode's tree narrows when the preview opens and the selected file row shifts vertically; Zeron's tree geometry stays fixed in that pilot. This is a qualitative design observation, not a repeated timing benchmark.
- **No GPU-drop, physical 120FPS, input-to-photon or native/webview ceiling conclusion is supported.** Warm Files-open retains an unexplained 14.266-second late raw ROI change; it is not established as panel-animation/load duration. Dataset sizes, pane widths and data/cache states are unequal.

Accepted evidence consists of ten trials per app/action for sidebar toggles, corrected palette toggles, warm terminal geometry and editor glyph insertion/undo. Warm Files toggles have ten mechanically valid trials per app/action with the disclosed unresolved tail. The remaining actions are explicitly untested or unavailable below. No product code was changed for this comparison.

## Quick measured comparison

Rounded medians in milliseconds, **10 runs per app/action**. Each value is a local raw-pixel observation from the same native input harness; detailed tables below retain input uncertainty and the full spread. These are selected-window captures on a120Hz display, not input-to-photon measurements.

| Action | ViewCode: first change → last crop change | Zeron: first change → last crop change | Main implication |
| --- | ---: | ---: | --- |
| Sidebar open |31 →31|31 →210|Similar onset; snap versus deliberate movement. |
| Sidebar close |32 →32|33 →188|Same motion-design distinction. |
| Warm terminal open |58 →58|33 →222|ViewCode also starts later in this fixture. |
| Warm terminal close |40 →40|29 →223|One-step removal versus animated height. |
| Palette open |59 →252|34 →50|ViewCode adds substantial decoration time. |
| Palette close |35 →233|26 →26|Zeron removes the overlay promptly. |
| Editor insertion |32 first glyph change|26 first glyph change|Small difference with overlapping spreads; no broad native-speed conclusion. |
| Warm Files open |62 first change|34 first change|Widths differ; final-settle comparison is qualified by an unresolved raw-pixel outlier. |

The file-open pilot also shows the ViewCode tree narrowing507→223px and moving its file rows40px downward. Zeron retains its tree geometry in the corresponding pilot. This is an observed layout jump, not a ten-run timing result.

## Confirmed issues and differences first

| Finding | Evidence class | Implication |
| --- | --- | --- |
| ViewCode's default motion is disabled. `DEFAULT_PANEL_ANIMATION_DURATION_MS=0`; allowed settings range0–400ms. Closing presence follows that setting, so zero can remove content immediately. | **Source-confirmed**; the user's physical observation is now corroborated by accepted ten-trial sidebar ROI cohorts. | Prioritize deliberate open/close motion and reversals. Do not describe instantaneous removal as smooth animation. |
| The zero default is deliberate: the source comment says width/height transitions cause per-frame layout work noticeable on lower-power clients. | **Source-confirmed reason**, not proof that every present machine would stutter. | Simply changing the default to200ms could trade a design gap for jank. Validate an animation implementation and layout cost together. |
| Zeron uses stable inner content clipped by an animated outer pane. Sidebar/right width tweens are180–240ms with cubic-bezier(.25,.1,.25,1); terminal height is200ms ease-out. | **Source-confirmed**, not measured presented-frame duration. | Study continuity, mask geometry and reversal rather than assuming “native is faster.” ViewCode's right pane already has a fixed-width clipped inner child; the surrounding chat may still reflow. |
| Palette design and observed crop timing differ. ViewCode has a 200ms dialog transition; Zeron directly mounts its palette. Corrected caret-free cohorts show ViewCode first crop change around59.3ms versus33.7ms for Zeron, and substantially later last change. | **Source plus accepted ROI measurements**, n=10 per app/action. | There is both an onset observation in this fixture and a motion-design difference. Their causes are not isolated; do not label the later settling CSS jank. |
| Warm Files-panel open also shows a later first crop change for ViewCode, while its close usually snaps and Zeron transitions. | **Measured native-default ROI**, with unequal widths505px/280px and one unexplained Zeron late open change. | Investigate first-open work separately from desired motion. Preserve the contaminated max; do not call14.266s panel-animation time. |
| Warm terminal geometry likewise differs: Zeron traverses21–23 changed crops; ViewCode changes in one crop in every warm open/close trial. | **Accepted geometry ROI**, n=10 per app/action; prompt/caret excluded. | Motion design remains the central difference. ViewCode's first crop change is later in these cohorts, but no cold startup, typing or prompt-ready timing follows. |
| File-open pilot: ViewCode tree width507→223px and`.gitattributes` row y644→684; Zeron tree280px and row y735 remain fixed. | **One primary-reviewed pilot/screenshot observation**, category(b), not a ten-run benchmark. | Stable file-tree geometry is a medium-risk continuity proposal; no onset/jank gain is inferred. |
| Existing data cannot support a matched long-history/streaming comparison. Zeron's default dataset has two short conversations, each one user+one assistant message. No active stream exists. | **Read-only copied-data and session receipts**. | Mark long/streaming cases unavailable for this fixture. Never substitute empty chats, fabricate history or launch mock agents and call that parity. |

ViewCode baseline source is `d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8`; unaccepted working-tree candidates are excluded. Sources: [default and range](https://github.com/CreatorGhost/ViewCode/blob/d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8/packages/contracts/src/settings.ts#L121), [reason comment](https://github.com/CreatorGhost/ViewCode/blob/d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8/packages/contracts/src/settings.ts#L337), [panel presence](https://github.com/CreatorGhost/ViewCode/blob/d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8/apps/web/src/panelAnimations.ts#L40), [right pane's existing fixed inner](https://github.com/CreatorGhost/ViewCode/blob/d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8/apps/web/src/components/preview/PreviewPanelShell.tsx#L110). Local links may move with later source edits; use the stated commit for exact baseline bytes.

Zeron release v0.2.114 is `2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a`; desktop Rust matches inspected main `c526d6f7cfc7a53e5588e3e6c5df7484a14d649f`. Pinned sources: [pane tween](https://github.com/zeronsh/zeron/blob/2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a/crates/ui/src/shell.rs#L1348-L1390), [terminal toggle](https://github.com/zeronsh/zeron/blob/2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a/crates/ui/src/shell.rs#L4795-L4842), [pane clipping](https://github.com/zeronsh/zeron/blob/2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a/crates/ui/src/shell.rs#L7094-L7129), [palette overlay](https://github.com/zeronsh/zeron/blob/2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a/crates/ui/src/shell/command_palette.rs#L1405-L1435). Pinned source trees: [ViewCode](https://github.com/CreatorGhost/ViewCode/tree/d3c81c2f6e4c9c4874f8ba8636b0c2a94cb532b8), [Zeron](https://github.com/zeronsh/zeron/tree/2e8f02ec2dfc521a20a5c43fcdbf4fae2381853a).

## What the four explanations currently support

| Classification | Current conclusion |
| --- | --- |
| **(a) Response time: ViewCode reacts later** | Sidebar first-change medians are close; the salient sidebar issue is motion design. Palette, warm Files and warm terminal open show later first crop-change medians for ViewCode in these fixtures. That observation does not isolate a cause or establish whole-app latency; widths/data/work differ. Other actions remain untested or unavailable. |
| **(b) Animation design: comparable response, different motion feel** | **Confirmed design mismatch**, corroborated by sidebar, Files and warm-terminal crops: Zeron transitions while ViewCode often snaps. Palette differs in the other direction: ViewCode has an extended entrance/exit while Zeron changes in very few crops. This is not a universal “more animation is better” recommendation; choose deliberate motion per action. Reversal remains unmeasured. |
| **(c) Dropped frames / jank** | **Not tested.** Capture idle frames, compositor-only updates, encoder loss and actual irregular app frames must be distinguished. No dropped-frame count is asserted. |
| **(d) A native/webview rendering limit** | **Unproven.** Neither app's architecture label establishes a ceiling. Mismatched data volume, settings, cache and content can dominate the comparison. No rewrite follows from this evidence. |

## Seven required action groups

“Not tested” means no accepted result exists in this finalized scope; it is not a promise of a later run. “Unavailable” identifies a known fixture limitation, not a delayed promise. All measured results below are local crops. Warm Files open retains a mechanically valid but semantically unlocalized late change. A measured toggle does not complete file loading, editor typing, palette navigation or whole-window readiness. For every latency table: each min/median/max is a post-after→post-before interval; spread L/U is max−min of the lower/upper-bound distributions, not a confidence interval.

### 1. Sidebar open / close — accepted left-panel crop only

All four primary-reviewed final02 cohorts have **n=10 valid trials, zero exclusions**. The reviewed pixels establish the intended sidebar open/closed states **inside the selected left-panel ROI**, not whole-window readiness. Labels below use accepted `observedAction`; ViewCode's raw scene labels were reversed because its starting state was open.

Times are milliseconds from the native driver's post bracket to the first or last changed **complete raw crop**. Each median is a lower–upper bound, retaining the input post uncertainty. “Spread L/U” is max−min for the lower-bound distribution / upper-bound distribution, not a confidence interval. No midpoint was substituted.

| App / action / crop metric | n | Min ms | Median ms | Max ms | Spread L/U ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Zeron open / first change | 10 | 15.938–15.966 | 31.344–31.418 | 44.036–58.122 | 28.098 / 42.156 |
| Zeron open / last change | 10 | 200.181–200.209 | 210.022–210.040 | 219.663–233.749 | 19.482 / 33.540 |
| Zeron close / first change | 10 | 16.554–16.592 | 33.034–33.179 | 35.124–35.152 | 18.571 / 18.561 |
| Zeron close / last change | 10 | 176.271–176.280 | 188.313–188.466 | 201.525–201.550 | 25.254 / 25.271 |
| ViewCode open / first change | 10 | 24.919–24.956 | 30.857–30.958 | 42.770–42.780 | 17.852 / 17.824 |
| ViewCode open / last change | 10 | 24.919–24.956 | 30.857–30.958 | 42.770–42.780 | 17.852 / 17.824 |
| ViewCode close / first change | 10 | 22.156–22.267 | 31.565–32.476 | 44.970–48.384 | 22.814 / 26.117 |
| ViewCode close / last change | 10 | 22.156–22.267 | 32.447–32.476 | 58.237–74.301 | 36.081 / 52.034 |

| App / action | Distinct changed crops: median (min–max) | First-to-last crop motion span: median (min–max), ms | Status |
| --- | ---: | ---: | --- |
| Zeron open | 20 (18–21) | 179.509 (173.096–187.813) | **Accepted for left-panel ROI** |
| Zeron close | 18 (17–19) | 156.250 (147.239–171.669) | **Accepted for left-panel ROI** |
| ViewCode open | 1 (1–1) | 0.000 (0.000–0.000) | **Accepted for left-panel ROI** |
| ViewCode close | 1 (1–2) | 0.000 (0.000–25.917) | **Accepted for left-panel ROI** |

The issue is the motion design, not demonstrated slower input onset: Zeron's first-change medians are about the same scale as ViewCode's, but it proceeds through 17–21 changed crops; ViewCode open has one changed crop in every trial and close has one in nine trials, two in one. This supports the user's observation of a snap versus a visible transition. Crop counts alone do **not** establish physical smoothness, refresh rate or every rendered frame.

Last change is an **accepted crop-settle observation**, not UI readiness: acceptance requires at least 100 ms of unchanged-crop callback coverage before the next input. Idle callbacks only establish coverage. All four analyses use `displayHostNs` and `hid-foreground`; event delivery and physical presentation remain unconfirmed. The widest individual post brackets are 14.086 ms for Zeron open and 16.064 ms for ViewCode close, which is why interval bounds are retained. There are no encoder-backpressure frames or missing encoded complete frames in these captures. Capture-delivery gaps are **not** attributed as GPU/display dropped frames or whole-window jank.

Sources: [accepted summary](timings/sidebar-final02-analysis-summary.json), [full scalar distributions and trial-analysis links](timings/sidebar-final02-analysis-summary.json). This sidebar finding remains separate from the warm Files qualifications, corrected palette and warm-terminal cohorts, and the unmeasured terminal typing/chat/navigation cases.

### 2. Right panel: diff / files open / close — warm Files measured with caveat

| Action | Source vs measured | Coverage status |
| --- | --- | --- |
| Open / close diff | Source: ViewCode default panel motion0ms; Zeron pane tween180–240ms. No diff-specific cohort is entered. | **Not tested** |
| Open / close already-loaded Files tree | Measured same raw ROI`[768,60,512,450]`, excluding caret. Root reviewed all20 states per recording. Native default widths differ: ViewCode505px, Zeron280px. | **10 mechanically valid trials per app/action**, not width-matched or cold-load proof |
| Cold file-tree/data readiness | Loaded panel geometry is not a new directory request/content receipt. | **Not tested** |

| App / action / crop metric | n | Min ms | Median ms | Max ms | Spread L/U ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Zeron open / first change | 10 | 18.054–18.062 | 34.495–34.514 | 42.793–42.826 | 24.739 / 24.764 |
| Zeron open / last change | 10 | 204.561–204.570 | 218.844–218.997 | 14266.482–14266.494 | 14061.920 / 14061.924 |
| Zeron close / first change | 10 | 18.591–18.705 | 34.287–34.312 | 48.116–59.955 | 29.525 / 41.250 |
| Zeron close / last change | 10 | 209.946–210.060 | 216.256–216.274 | 230.308–242.148 | 20.363 / 32.088 |
| ViewCode open / first change | 10 | 57.018–57.048 | 61.910–61.926 | 69.081–69.104 | 12.063 / 12.055 |
| ViewCode open / last change | 10 | 79.126–79.135 | 93.440–93.461 | 100.161–100.184 | 21.035 / 21.049 |
| ViewCode close / first change | 10 | 33.894–33.906 | 36.423–37.788 | 42.222–48.803 | 8.329 / 14.897 |
| ViewCode close / last change | 10 | 33.894–33.906 | 37.766–37.788 | 53.834–66.532 | 19.940 / 32.626 |

| App / action | Changed crops: median (min–max) | Interpretation |
| --- | ---: | --- |
| Zeron open |21(20–41)|Median last-change interval218.844–218.997ms is a crop observation. Final trial has an unlocalized late ROI change. |
| Zeron close |21(19–22)|Multi-step pane motion in this crop. |
| ViewCode open |3(2–3)|A few crop changes; first change is later in this native-default fixture. |
| ViewCode close |1(1–2)|Usually a single-step change, consistent with disabled panel motion. |

**Keep the anomaly visible:** Zeron open's last-change maximum is **14,266.482–14,266.494ms**, and full spread **14,061.920 /14,061.924ms**. It passes the unchanged mechanical quiet gate, but the late spatial change is not localized. It is **not established as panel-animation duration, a 14-second panel load or GPU/CSS jank**. No trial was silently removed. An exact-frame spatial diagnostic compared the immediately preceding encoded frame with the final raw-hash-change frame: the **lossy decoded movie ROI has 0 differing pixels even at a >0 channel threshold**, despite differing raw BGRA crop hashes. Therefore that movie cannot spatially localize the raw change. This does not prove a missing raw change, harmlessness, animation, or jank; the cause remains unresolved. [Exact spatial diagnostic](timings/audit-metadata.json). The ordinary median/p90 remain descriptive ROI statistics; a clean settle comparison is unavailable because that last trial remains unresolved. Unequal widths and warm loaded content also prevent attributing onset differences solely to rendering architecture.

[Files-panel summary](timings/files-panel-analysis-summary.json), [full distributions and analysis links](timings/files-panel-analysis-summary.json). Logical file-tree readiness, first cold load and diff behavior remain unmeasured.

### 3. Terminal — accepted warm geometry; cold startup and typing untested

| Action | Source vs measured | Coverage status |
| --- | --- | --- |
| First/cold terminal open | Source has separate module/WASM/surface/PTy readiness. No cold cohort entered. | **Not tested** |
| Warm terminal open / close | Four geometry cohorts,10/10 valid trials each, zero exclusions. Primary reviewed all20 states per app with prompt visible when open. | **Accepted only for geometry ROI** |
| Terminal typing/echo | Prompt/caret are deliberately outside the geometry crop; no input/echo receipt measured. | **Not tested** |

Both geometry crops are **`[1000,512,240,388]`**, excluding prompt/caret. These are warm already-created terminals. First/last crop change is not cold startup, prompt readiness, typed-character echo or whole-window readiness. Each min/median/p90/max below is a native post-bracket lower–upper interval, not an application-delivery or physical-presentation claim.

| App / action / crop metric | n | Min ms | Median ms | P90 ms | Max ms | Spread L/U ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Zeron open / first change | 10 | 19.669–19.678 | 32.911–32.932 | 35.651–35.678 | 44.577–56.461 | 24.908 / 36.782 |
| Zeron open / last change | 10 | 216.772–216.781 | 221.612–221.729 | 229.895–229.925 | 235.689–247.572 | 18.917 / 30.791 |
| Zeron close / first change | 10 | 22.677–22.689 | 29.494–29.514 | 34.245–34.642 | 35.863–35.886 | 13.186 / 13.197 |
| Zeron close / last change | 10 | 212.104–212.114 | 223.004–223.029 | 225.311–225.322 | 227.177–227.186 | 15.073 / 15.072 |
| ViewCode open / first change | 10 | 44.816–44.824 | 57.767–57.791 | 73.796–74.938 | 74.820–85.517 | 30.005 / 40.693 |
| ViewCode open / last change | 10 | 44.816–44.824 | 57.767–57.791 | 73.796–74.938 | 74.820–85.517 | 30.005 / 40.693 |
| ViewCode close / first change | 10 | 35.211–35.232 | 39.540–39.607 | 46.626–46.659 | 46.775–46.801 | 11.563 / 11.568 |
| ViewCode close / last change | 10 | 35.211–35.232 | 39.540–39.607 | 46.626–46.659 | 46.775–46.801 | 11.563 / 11.568 |

| App / action | Changed crops: median (min–max) | First-to-last crop motion span median (min–max), ms |
| --- | ---: | ---: |
| Zeron open | 22 (21–23) | 190.770 (186.800–197.212) |
| Zeron close | 22 (22–22) | 190.357 (185.382–202.633) |
| ViewCode open | 1 (1–1) | 0.000 (0.000–0.000) |
| ViewCode close | 1 (1–1) | 0.000 (0.000–0.000) |

This corroborates a geometric transition versus a snap: Zeron progresses through 21–23 changed crops, while every ViewCode warm open and close has one changed crop. The later ViewCode first-change medians are a separate observation; source does not isolate their cause. Zeron's later last change is compatible with its deliberate 200ms reveal and is **not evidence of a slower ready terminal**. Timing uses complete raw hashes and`displayHostNs`; last change requires 100ms subsequent unchanged callback coverage. Neither idle coverage nor changed-crop count is a physical frame-rate/drop result.

[Terminal summary](timings/terminal-analysis-summary.json), [full distributions and analysis links](timings/terminal-analysis-summary.json). Cold startup, PTY acceptance/prompt readiness and typing remain open.

### 4. File tree, tabs and editor glyph typing

| Action | Evidence scope | Final coverage |
| --- | --- | --- |
| File-tree data load / directory browse | Warm Files show/hide is measured in group2; new directory/data readiness is separate. | **Not tested** |
| File open / preview geometry | One actual pilot per app; screenshot geometry below. No repeated file-open timing cohort. | **Qualitative pilot only** |
| File-tab switch | No accepted cohort. | **Not tested** |
| Editor insert`x` / undo to empty | Four cohorts,10/10 valid trials each; primary magnified/reviewed all 20 glyph states per app. | **Accepted4×12px glyph ROI only** |

**File-open geometry pilot (category b):** opening the preview changes ViewCode's tree width from507px to223px and the root`.gitattributes` row y from644 to684. Zeron keeps its tree280px wide and that row y735. These are one-pilot observed coordinates in each app, not a universal layout invariant or ten-run timing result. Before/after evidence: [ViewCode pilot](screenshots/viewcode-tree-before.png), [ViewCode opened preview](screenshots/viewcode-tree-after.png), [Zeron setup](screenshots/zeron-tree-before.png), [Zeron opened preview](screenshots/zeron-tree-after.png). No independent frame/timing inference is made from those screenshots.

**Typing setup:** same copied`.gitattributes` blank line9 and window placement. Raw crop is **4×12px glyph interior**, origin ViewCode`[785,444]`, Zeron`[656,258]`, following the actual editor positions and avoiding initial/after carets. This measures glyph-pixel appearance/disappearance only, not whole-editor readiness or general typing latency. The primary reports copied file hashes unchanged after insertion/undo. Reviewed cursor overlay policy is retained in the analysis evidence.

| App / action / crop metric | n | Min ms | Median ms | P90 ms | Max ms | Spread L/U ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Zeron insert x / first change | 10 | 23.651–23.677 | 25.809–25.830 | 35.088–35.113 | 60.337–72.618 | 36.686 / 48.941 |
| Zeron insert x / last raw change | 10 | 340.357–340.368 | 345.308–345.338 | 356.219–356.228 | 368.786–381.067 | 28.429 / 40.699 |
| Zeron undo / first change | 10 | 16.085–16.105 | 33.219–33.257 | 36.549–36.558 | 37.569–37.601 | 21.484 / 21.496 |
| Zeron undo / last raw change | 10 | 16.085–16.105 | 33.219–33.257 | 36.549–36.558 | 37.569–37.601 | 21.484 / 21.496 |
| ViewCode insert x / first change | 10 | 24.773–24.784 | 31.893–31.905 | 38.494–38.505 | 56.892–68.553 | 32.119 / 43.769 |
| ViewCode insert x / last raw change | 10 | 24.773–24.784 | 31.893–31.905 | 38.494–38.505 | 56.892–68.553 | 32.119 / 43.769 |
| ViewCode undo / first change | 10 | 25.327–25.338 | 28.318–28.328 | 34.456–34.467 | 34.575–34.590 | 9.249 / 9.252 |
| ViewCode undo / last raw change | 10 | 26.327–26.336 | 31.067–31.087 | 34.456–34.467 | 42.941–42.956 | 16.614 / 16.619 |

| App / action | Changed crops median (min–max) | Interpretation |
| --- | ---: | --- |
| Zeron insert x |2(2–2)|First appearance median25.809–25.830ms; later second change at345.308–345.338ms is **unassigned**, not UI-settle time. |
| Zeron undo |1(1–1)|Glyph disappearance in one changed crop. |
| ViewCode insert x |1(1–1)|Glyph appears in one changed crop. |
| ViewCode undo |1(1–2)|A few trials have a second raw change; no whole-editor meaning assigned. |

The field named`settleLatencyBracketMs` in the analyzer is reported here as **last raw crop change**. The quiet-coverage gate does not assign its cause. In particular, Zeron's consistent later insert change cannot be labelled animation, delayed editing, jank or completed UI readiness from this tiny ROI. First-change insertion and undo distributions point in different directions; these trials do not support an app-wide native superiority claim.

[Editor summary](timings/editor-typing-analysis-summary.json), [full scalar evidence](timings/editor-typing-analysis-summary.json), [ViewCode glyph proof](timings/audit-metadata.json). Native post-bracket bounds/display timestamps remain distinct from application delivery and physical presentation; no synthetic frames or interpolation.

### 5. Warm and cold chat switching

| Action | Current fixture limit | Response / settling / frame result | Status |
| --- | --- | --- | --- |
| Warm chat switch | Current Zeron fixture has ten empty chats; ViewCode holds a much larger safety-edited real-data shell. | Not tested; only an explicitly labelled empty-chat case is comparable. | **Not tested** |
| Cold chat switch | Define cold membership/subscription/cache state independently of application startup. | Not tested; no long-history equivalence can be claimed. | **Not tested** |

### 6. Long-history and streaming scroll

| Action | Availability | Result | Status |
| --- | --- | --- | --- |
| Long-chat scroll / reading-return | Default Zeron data has only two short conversations, two messages each; ten seeded chats are empty. | No valid matched long-history cohort. | **Unavailable with current data** |
| Streaming scroll | No active Zeron sessions/streams; agent launches are excluded from this trial. | No streaming result. | **Unavailable with current data** |

### 7. Palette open / close — accepted corrected crop; navigation untested

The final ROI is **`[600,300,400,400]`**, identical for both apps and excluding query/composer carets. Four cohorts have **10/10 valid trials, zero exclusions**; root reviewed all20 states per recording. These results **supersede**, rather than combine with, the earlier caret-affected palette measurements. The old extra close pixels were diagnosed as the composer's blinking caret; they are not evidence of animation or CSS/GPU jank.

| Action | Source vs measured | Coverage status |
| --- | --- | --- |
| Open | Source: ViewCode 200ms scale/opacity/translate transition; Zeron direct overlay. Measured crop onset and last change below. | **Accepted corrected ROI**, n=10 per app |
| Close | Measured one-step Zeron crop versus a multi-step ViewCode exit, in the caret-free ROI. | **Accepted corrected ROI**, n=10 per app |
| Arrow/list navigation, disabled skipping, Enter | The open/close cohorts do not test the selected item or key handling. | **Not tested** |

| App / action / crop metric | n | Min ms | Median ms | Max ms | Spread L/U ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Zeron open / first change | 10 | 18.407–18.439 | 33.724–33.732 | 46.977–58.527 | 28.570 / 40.088 |
| Zeron open / last change | 10 | 40.916–40.937 | 50.361–50.423 | 64.749–76.298 | 23.833 / 35.362 |
| Zeron close / first change | 10 | 17.524–17.559 | 25.927–26.126 | 37.636–37.645 | 20.112 / 20.087 |
| Zeron close / last change | 10 | 17.524–17.559 | 25.927–26.126 | 37.636–37.645 | 20.112 / 20.087 |
| ViewCode open / first change | 10 | 53.811–53.846 | 59.260–59.296 | 91.217–102.607 | 37.406 / 48.761 |
| ViewCode open / last change | 10 | 238.235–238.254 | 251.534–251.560 | 278.699–290.089 | 40.464 / 51.835 |
| ViewCode close / first change | 10 | 25.187–25.226 | 34.780–34.791 | 39.246–39.256 | 14.058 / 14.030 |
| ViewCode close / last change | 10 | 225.811–225.822 | 232.482–232.516 | 241.500–241.509 | 15.689 / 15.686 |

| App / action | Changed crops: median (min–max) | First-to-last crop motion span median ms |
| --- | ---: | ---: |
| Zeron open | 2 (2–2) | 17.507 |
| Zeron close | 1 (1–1) | 0.000 |
| ViewCode open | 21 (20–23) | 191.278 |
| ViewCode close | 21.5 (20–22) | 201.333 |

In this ROI, ViewCode first changes later on open, then continues changing for its entrance/exit; Zeron changes in two crops on open and one on close. This does not identify whether ViewCode's initial delay is result construction, focus/style/layout, scheduling or another cause. It does **not** show that every action should animate longer or that fewer changed crops always mean better design. Last change remains crop settling after quiet-coverage validation, not “fully usable,” whole-window completion or physical presentation.

[Final caret-free summary](timings/palette-caret-free-analysis-summary.json), [full distributions and analysis links](timings/palette-caret-free-analysis-summary.json). All timing uses complete raw hashes and`displayHostNs`, unchanged100ms quiet coverage, and native post-bracket bounds; no interpolated frames or midpoint. No capture backpressure/missing encoded complete frames are reported in these cohorts.

## Top five next proposals, ordered by motion feel and risk

These exactly five recommendations supersede the earlier general ranking in [proposals.md](#top-five-next-proposals-ordered-by-motion-feel-and-risk). These are proposals for a later implementation. Benefits beyond the observed motion differences remain conditional.

| Priority | Recommendation | Measured / observed basis | Expected gain and risk — conditional |
| --- | --- | --- | --- |
| **1 — high** | Use deliberate panel/terminal open-and-close motion, with reversal and direct-drag bypass. | Source0ms default plus accepted snap-versus-transition crops; sidebar onset is similar-scale. | A 200ms transition replacing 0ms could add continuity; **not 200ms faster**. It may settle later and introduce layout cost. Preserve reduced motion, look, coherent content and prompt acknowledgement. |
| **2 — high** | Prioritize palette immediacy and simplify its entrance/exit separately from result-work changes. | Accepted caret-free crops show later ViewCode first change and prolonged entrance/exit. Cause of onset difference remains unproven. | Removing the current entrance/exit decoration could remove roughly190–200ms of visual settling in this fixture; that is an estimate from the observed transition spans, not a tested implementation gain. It would not explain the separate onset gap. Result-work changes help only if causal. Preserve exact layout, focus, keyboard/disabled handling and large lists; no native rewrite follows. |
| **3 — medium risk** | Keep the file tree's usable width and row placement stable when opening a preview. | One pilot: ViewCode507→223px tree and row y644→684; Zeron280px/y735 unchanged. Category(b), not timing evidence. | Could improve spatial continuity and reduce target movement; no measured milliseconds/FPS gain. Tradeoffs include editor width, window minima, narrow layout and user resize preference. Reuse existing clipped/stable inner geometry where applicable. |
| **4** | Prefer intent-based terminal module/WASM and existing editor-worker reuse over indiscriminate preload. | Source shows existing loader promise, shared worker pool and versioned highlight gate. Warm geometry/glyph cohorts do not measure cold loader costs. | Could move cold work before a click if it is causal; may cost startup CPU/memory. No pre-opened PTY/provider, ungranted file access or premature editor unlock. Magnitude unknown. |
| **5** | Preserve exact transcript preparation/scroll-restoration correctness before expanding retention or rewriting rendering. | Source cache/lifecycle findings; no matched long-history or warm/cold chat timing cohort in this finalized scope. | Could avoid repeated work if causal, but larger retention can worsen cold paths/memory. Gain unknown. Owned visible row, reading offset, rapid switches and embedded-content authority remain requirements; no native/webview ceiling is established. |

## Dataset, isolation and evidence limits

- **Unequal data is a material confounder:** ViewCode's copied, safety-edited database has493 native thread rows plus491 legacy shell rows, whereas the new normal-Local Zeron fixture has ten empty chats. These are different populations, not a matched workload. Without a balanced cohort controlling visible rows, content volume, cache state and workspace/file set, these differences cannot be attributed to native versus webview architecture.
- The user's existing default Zeron data was inspected through a read-only SQLite `VACUUM INTO` task copy. It contains only two short chats/four total messages, not a long-history substitute. [Availability and counts](timings/audit-metadata.json).
- [Owned-process observation](timings/audit-metadata.json) records the isolated Zeron main process plus an`sh` child, and ViewCode's Electron helpers/renderer/backend plus a`zsh` child. No agent/provider executable is visible in that recorded process tree. This is **only a point-in-time observation**, not a continuous no-spawn guarantee or an explanation of performance; process counts alone do not establish overhead. Both apps' providers remain configured off for this comparison.
- The accepted isolated Zeron configuration is the official release in **normal Local scope**, with all nine providers disabled and update policies Off, no auth session/token/sync. The earlier Development-profile fixture is a separate superseded setup and must not supply final normal-Local timings. [Preparation](timings/audit-metadata.json), [ten-chat receipt](timings/audit-metadata.json), [point-in-time status](timings/audit-metadata.json): zero active sessions and zero sync rooms at that snapshot. It is not a continuous no-background-work proof.
- [ViewCode copied artifact](timings/audit-metadata.json) preserves original baseline assets; failed startup/input/capture attempts are excluded, not labelled instant performance. The source audit records those limits.
- [Capture protocol](timings/audit-metadata.json), [raw captures](timings/audit-metadata.json), [recordings](timings/audit-metadata.json) and input plans preserve the evidence. Final02 sidebar, corrected caret-free palette, warm terminal geometry and narrowly scoped editor glyph cohorts are accepted here; the glyph last-change cause is not assigned. Warm Files cohorts are mechanically valid with the disclosed unlocalized late-open change; other captures are not automatically accepted. ScreenCaptureKit requested cadence, delivered frame count, WindowServer timestamp, renderer Paint and physical presentation are different quantities. No input-to-photon or physical refresh-drop result is claimed.

## Final coverage boundary

Testing ended after the core findings. Coverage of the original matrix is **partial**, as listed below. Recorded and reviewed: sidebar toggles, corrected palette toggles, warm Files toggles with the unresolved tail qualification, warm terminal geometry, and narrow editor glyph insertion/undo. File open adds only the disclosed qualitative pilot.

**Untested:** repeated file-open/cold-tree loading and browsing, file-tab switching, cold/warm chat switching, palette Arrow/list navigation/Enter, terminal typing/echo and cold startup, and diff-panel-specific behavior. **Unavailable with current data:** matched long-history and streaming scroll. 

The strongest confirmed issue is inconsistent motion design: panels/terminal snap while the palette has an extended transition. Several open-crop onset differences are also observed, with cause unproven. The file-tree pilot identifies spatial movement worth considering. No GPU-drop count, physical 120FPS presentation, input-to-photon measurement or irreducible native/webview ceiling is established. Product source remains unchanged.

## Evidence and cleanup

[Recording index](evidence-index.md) links the two apps’ original movies, full frame/input logs and reviewed states. Published evidence is limited to timing JSON and eight cropped frames. Original movies and tooling remain local.

The isolated ViewCode main/backend and Zeron processes were stopped by their captured PIDs; their test shells also exited. [Cleanup actions](timings/audit-metadata.json), [final cleanup receipt](timings/audit-metadata.json). Existing user app instances were left running.

[Final source/fixture verification](timings/audit-metadata.json) confirms the speed branch HEAD, pre-existing dirty files and protected header CSS match their starting values. The throwaway editor file is restored. No product commit, push or live-data write was performed.
