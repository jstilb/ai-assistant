---
status: accepted
date: 2026-06-08
deciders: Jm (grilled one decision at a time), Kaya (investigation + recommendations)
---

# Native surface reconciliation: consumer learns `native`, verifies it honestly

## Context

The spec-pipeline **producer** classifies each work item's surface with an LLM
(`KayaTaskClassifier.ts:50`) into one of:

```
browser | native | cli | api | library
```

where `native` = "a mobile or desktop app UI (iOS, Android, macOS, Electron)"
(`KayaTaskClassifier.ts:225`). When the surface is `browser` **or** `native`,
the producer runs the UX/UI Stage (`SpecPipelineRunner.ts:782`), emitting a
structurally-identical UX/UI spec (Screen Inventory YAML, Screen×State Matrix,
Mermaid flows, Given/When/Then → ISC rows) — the only difference is the render
target (`screen-inventory.yaml:23`: `route` = "URL route (browser) or nav path
(native)"). The producer emits a *tech-agnostic* lo-fi UI spec, **not** React
Native code. In practice the real native target is `~/Desktop/projects/kaya-mobile`
= **Expo / React Native** (jest units; no Detox/Appium).

The **consumer** (AutonomousWork) had no `native` concept. Investigation found
**three independent surface taxonomies that were never connected**:

| Layer | Type | Values |
|-------|------|--------|
| Producer | `Surface` (`KayaTaskClassifier.ts:50`) | browser, native, cli, api, **library** |
| Consumer item | `WorkItem.surface` (`WorkQueue.ts:206`) | browser, cli, api, **daemon**, library |
| Consumer verify | `WorkSurface` (`SurfaceClassifier.ts:17`) | browser, cli, api, **integration** |

### Root cause (the real gap)

The consumer **never reads the producer's `surface` field**. `SurfaceClassifier`
re-derives surface from (a) spec-text keyword regexes and (b) git-diff file
patterns. Worse, item import (`WorkQueue.ts:1099` `importFromApprovalQueue`)
reads `payload.context` but **drops `context.surface`**, so the producer's LLM
verdict is discarded before the consumer ever sees it.

Consequence: a `native` spec is **not** rejected as "unknown surface" (the string
"native" never reaches the consumer). Instead `detectSpecSignals` matches browser
keywords (`render/component/button/form/panel/ui` — all present in any native
UX/UI spec) → native work is **mis-classified `browser`** → `BrowserStrategy`
boots a web dev server + `bunx playwright test` against an Expo/RN app with no web
server → the per-slice live gate fails as a confusing **environment** error
(false negative), or silently returns `passed:true` when no browser test files
exist (`RuntimeVerifier.ts:751`). Either way the per-slice live gate is
**meaningless** for native.

### Environment reality (probed 2026-06-08)

| Tool | Status |
|------|--------|
| `xcrun simctl` | **MISSING** (CommandLineTools only, not full Xcode) — no iOS sim / XCUITest |
| `emulator` | **MISSING** — cannot launch an Android emulator |
| `adb` | present (`/opt/homebrew/bin/adb`) — can only talk to a physically-attached device |
| `detox`, `appium` | **not installed** |

There is **no turn-key automated native UI test path** in this environment.

## Decisions

Three decisions, grilled one at a time, each with a recommendation Jm accepted.

### Decision 1 — Native gate strategy: **human/device-required + non-gating test evidence** (option c+b hybrid)

Native UI live verification is **not** automatable here, so the consumer must not
pretend it is. `NativeStrategy`:

- runs whatever unit/integration tests exist (`bun test` on the native test
  files) as **non-gating evidence** — a hard FAIL still blocks (the code is
  broken at the unit level), but
- a unit-test PASS does **not** satisfy the UI gate. The result carries
  `humanVerificationRequired = true`, which dispositions the native UI ISC rows
  as `human-required` (`SkepticalVerifier.ts:103`). `CompletionPipeline.ts:387`
  already routes "only human-required → create proxies + jm-task + audit log;
  mark item **blocked**" — so a native item is **never auto-DONE** without a
  human/device check.

Rejected: pure (b) map→integration (would let a native slice claim "live
verified" with zero UI exercised — "mirage native"); pure (a) real NativeStrategy
(unbuildable here without provisioning Xcode/emulator + Detox/Appium).

### Decision 2 — Surface source: **bridge to the producer's `surface`, heuristic fallback**

Fix the root cause, not the symptom. The consumer reads the producer's
LLM-classified surface as **authoritative**:

1. plumb `context.surface` → `WorkItem.surface` at import (`WorkQueue.ts`);
2. resolve `WorkSurface` from `item.surface` first
   (`browser→browser, cli→cli, api→api, native→native, library→integration,
   daemon→integration`);
3. fall back to the keyword/diff heuristic **only** when no producer surface is
   present (legacy specs).

Rejected: heuristic-only + native keyword detection (treats the symptom; keeps
re-guessing what the producer already decided with an LLM).

### Decision 3 — Scope: **native + library, full reconciliation**

While adding `native`, also map the producer's `library` → `integration` so
**every** producer surface value has a defined consumer path. The
`native → human-required` disposition is applied **consumer-side** (the producer
does not know the consumer's verification infra).

## Consequences

- `WorkSurface` gains `native` (`SurfaceClassifier.ts`). `WorkItem.surface` and
  `WorkItemMetadata.workSurface` gain `native`.
- `TestFiles` gains `native: string[]`; `RuntimeVerifierInput.workSurface`,
  `RuntimeVerificationResult.surface`/`strategy` gain `native`/`NativeStrategy`;
  `RuntimeVerificationResult` gains `humanVerificationRequired: boolean`
  (default `false`).
- `importFromApprovalQueue` copies `context.surface` into `item.surface`.
- A surface-resolution bridge prefers the producer value, heuristic as fallback.
- The per-phase gate threads `humanVerificationRequired`; native UI rows route to
  `human-required` rather than a (meaningless) browser screenshot gate.
- Prompts (`Orchestrate.md`, `TestWriterPrompt.md`, `VerifierPrompt.md`) note:
  native surface → no web dev-server/Playwright/screenshot gate; device
  verification is human-required.
- **Out of scope (producer-owned):** `SpecPipelineRunner.ts`, `KayaTaskClassifier.ts`,
  `SpecSheet`/UXSpec/UISpec. This ADR governs the **consumer** only. If a real
  `NativeStrategy` is ever wanted, it requires provisioning device infra first
  (re-plan trigger).

## Adversarial-review fixes (found by per-slice skeptical verification)

The build was gated by an independent skeptical agent per slice; two silent
auto-DONE holes were found and closed before completion:

1. **CLI gate dropped the rows.** `WorkOrchestratorCLI.ts verify-phase` (the path
   `Orchestrate.md` actually invokes) hard-coded `iscRowIds: []`, so the native
   `human-required` disposition never fired in production. Fix: the CLI now parses
   `--phase-rows`; `verifyPhase` falls back to **all** the item's rows when none
   are passed; `Orchestrate.md` passes `--phase-rows`. Belt-and-suspenders.

2. **Stale `metadata.workSurface` overrode the producer.** The item-level
   `verify()` path resolved `metadata.workSurface ?? classify(...)`, so a stale
   cached `"browser"` (from a pre-bridge `prepare()`) would beat
   `item.surface="native"` and route to `BrowserStrategy` with no human gate. Fix:
   resolution is now `mapProducerSurface(item.surface) ?? metadata.workSurface ??
   classify(...)` — the producer's value wins. **Residual (accepted):** an item
   imported *before* the `loadFromLegacy` bridge has `item.surface=undefined` and
   `loadFromLegacy` skips already-imported IDs, so its dropped native signal isn't
   recovered without a one-time re-prepare. Bounded, non-recurring; all
   post-fix imports are protected.
