# Media-Value Rubric — G37 YouTube classifier calibration

This file is read **at run time** by `Tools/YouTubeClassifier.ts` (same pattern as
`YouTubeCuration/Rubric.md` → `SeedSourcer.ts`): the `## Classification guidance`
section below is appended verbatim to the classifier's system prompt on every
nightly run. Editing this file changes classification behavior with **zero code
edits**. The classifier fails loud if this file or that section is missing.

Guidance lands here via the weekly calibration loop
(`Tools/CalibrationSampler.ts` + the recurring LucidTasks task): Jm reviews a
stratified sample sheet in `Desktop/obsidian/POS/Reviews/YouTube Calibration/`,
and the next round distills his overrides into bullets below. Keep bullets
short, concrete, and about *patterns* (channels, genres, formats) — one-off
video corrections go straight into `youtube_verdicts` as `jm-calibration` rows
via `CalibrationSampler.ts apply-verdict`, not here.

## Classification guidance

- (None yet — this section is populated from Jm's weekly calibration review rounds. Until the first round is applied, the classifier runs on its base definitions alone.)

## Calibration log

One row per applied round. "Overrides" = per-video verdict corrections written
as `jm-calibration`; "Guidance changes" = bullets added/edited above.

| Round | Applied | Reviewed | Overrides | Guidance changes |
|-------|---------|----------|-----------|------------------|
