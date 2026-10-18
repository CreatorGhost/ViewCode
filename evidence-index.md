# Evidence index

This orphan branch is reference material for Claude’s speed/motion work. It will never be merged. It contains two Markdown documents, original raw timing records and analyses as JSON, and eight cropped screenshots. No videos, application source, databases, authentication material or test executables are included.

## Timing data

Each per-case JSON preserves the original `frames` and `nativeInputMarkers` records. Numeric timestamps and SHA-256 crop hashes are unchanged. `captureMetadata` retains only measurement fields. Original video is deliberately excluded. The per-trial analysis JSON contains the acceptance outcome, input timing bounds, first/last changed-frame indices and full distributions.

| Case | Zeron raw data | ViewCode raw data | Summary |
| --- | --- | --- | --- |
| Sidebar | [JSON](timings/zeron-local-sidebar-final02.json) | [JSON](timings/viewcode-sidebar-clean-final02.json) | [Distributions](timings/sidebar-final02-analysis-summary.json) |
| Palette, caret-free | [JSON](timings/zeron-palette-final03.json) | [JSON](timings/viewcode-palette-final04.json) | [Distributions](timings/palette-caret-free-analysis-summary.json) |
| Warm Files pane, qualified tail | [JSON](timings/zeron-files-panel-final01.json) | [JSON](timings/viewcode-files-panel-final01.json) | [Distributions](timings/files-panel-analysis-summary.json) |
| Warm terminal geometry | [JSON](timings/zeron-terminal-final01.json) | [JSON](timings/viewcode-terminal-final01.json) | [Distributions](timings/terminal-analysis-summary.json) |
| Editor glyph insertion/undo | [JSON](timings/zeron-editor-typing-final01.json) | [JSON](timings/viewcode-editor-typing-final01.json) | [Distributions](timings/editor-typing-analysis-summary.json) |

[Conditions and cleanup](timings/audit-metadata.json). Capture capped at120fps on the120Hz main display; no physical refresh/drop claim. Same1280×900 windows; editor tests moved both windows together to448,150. Files widths differ. The ViewCode sidebar raw scene labels are reversed; accepted analysis corrects the observed action without changing raw input labels.

## Key frames

Images are exact crops of recorded app frames, without generated or repainted pixels. Cropping excludes the copied real-data chat sidebar. The glyph contact sheets use nearest-neighbor magnification solely for reviewing insertion and undo; they are not pixel-timing inputs.

| Observation | ViewCode | Zeron |
| --- | --- | --- |
| Palette open | [Frame](screenshots/viewcode-palette.png) | [Frame](screenshots/zeron-palette.png) |
| Tree before file preview | [Frame](screenshots/viewcode-tree-before.png) | [Frame](screenshots/zeron-tree-before.png) |
| Tree after file preview | [Frame](screenshots/viewcode-tree-after.png) | [Frame](screenshots/zeron-tree-after.png) |
| Editor insert/undo states | [Frames](screenshots/viewcode-editor-glyphs.png) | [Frames](screenshots/zeron-editor-glyphs.png) |

The tree geometry comparison is one qualitative pilot per app. It is not a repeated file-open benchmark. Earlier failed or caret-affected cohorts are excluded from these published timings. Full coverage and limitations are in [the report](report.md).
