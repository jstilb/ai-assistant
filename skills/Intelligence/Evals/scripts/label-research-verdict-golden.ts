#!/usr/bin/env bun
/**
 * label-research-verdict-golden.ts
 *
 * Builds the research-verdict golden set via REAL ensemble labeling.
 *
 * For each item, runs the EnsembleLabelGrader (fast + standard + smart)
 * using the research rubric from ensemble-known-truth.yaml (single source of truth).
 *
 * Input sources:
 *   (A) REAL rows from spec-pipeline.jsonl that have a verdict in _meta.
 *       These are labeled from their research artifact markdown (truncated to
 *       ~2000 chars). Falls back to title + verdictReason if artifact missing.
 *   (B) SYNTHETIC cases — realistic research-finding snippets that cover all
 *       three verdict classes (implement / skip / defer), hand-authored to
 *       mirror the style of real research artifacts.
 *
 * Writes one JSONL line per case to:
 *   skills/Intelligence/Evals/Data/golden/research-verdict-golden.jsonl
 *
 * Consensus cases  → { itemId, verdict, source:'ensemble', labeled_at, criteria_version, origin }
 * Divergent cases  → { itemId, verdict:null, divergent:true, votes, source:'ensemble', labeled_at, criteria_version, origin }
 *
 * Usage:
 *   bun skills/Intelligence/Evals/scripts/label-research-verdict-golden.ts
 *   bun skills/Intelligence/Evals/scripts/label-research-verdict-golden.ts --dry-run
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Config
// ============================================================================

const CRITERIA_VERSION = 1;
const KAYA_HOME = getKayaHome();
const PIPELINE_JSONL = join(KAYA_HOME, "MEMORY/QUEUES/spec-pipeline.jsonl");
const OUTPUT_PATH = join(import.meta.dir, "../Data/golden/research-verdict-golden.jsonl");
const ARTIFACT_TRUNCATE_CHARS = 2000;
const MAX_ROWS = 25;

// ============================================================================
// Research rubric (mirrors ensemble-known-truth.yaml research bucket)
// — single source of truth: same rubric the spec pipeline uses
// ============================================================================

const RESEARCH_SYSTEM_PROMPT = `You are a research verdict classifier. Given research findings for a proposed
software feature or improvement, classify whether to implement, skip, or defer.
Return ONLY valid JSON with the key "verdict".

Verdict rules:
- implement: The premise is confirmed, the path is clear, and building now is
  the right call. Evidence shows real need and feasibility.
- skip: The premise is false or the need is already met (e.g., existing code
  already handles it). Building would be wasteful.
- defer: The work is blocked by an external dependency, missing prerequisite,
  or timing issue. Worth revisiting later but not actionable now.

Return: {"verdict": "implement" | "skip" | "defer"}`;

const CANDIDATE_FIELD = "verdict";
const VALID_VERDICTS = new Set(["implement", "skip", "defer"]);

// ============================================================================
// Types
// ============================================================================

interface PipelineItem {
  itemId: string;
  title: string;
  verdictFromPipeline: string;
  artifactPath: string;
  verdictReason: string;
  input: string;        // what we actually label (artifact text or fallback)
  inputSource: "artifact" | "fallback";
}

interface SyntheticCase {
  itemId: string;
  title: string;
  input: string;        // research findings text
  origin: "synthetic";
}

// ============================================================================
// Load real pipeline rows
// ============================================================================

function loadRealRows(): PipelineItem[] {
  if (!existsSync(PIPELINE_JSONL)) {
    console.warn(`[warn] spec-pipeline.jsonl not found at ${PIPELINE_JSONL}`);
    return [];
  }

  const lines = readFileSync(PIPELINE_JSONL, "utf-8").split("\n").filter(Boolean);
  const rows: PipelineItem[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const meta = (obj?.payload as Record<string, unknown>)?.context as Record<string, unknown>;
      const _meta = meta?._meta as Record<string, unknown> | undefined;
      if (!_meta?.verdict) continue;

      const artifactPath = (_meta.researchArtifactPath as string | undefined) ?? "";
      let input = "";
      let inputSource: "artifact" | "fallback" = "fallback";

      // Try to read artifact on disk
      if (artifactPath && existsSync(artifactPath)) {
        try {
          const raw = readFileSync(artifactPath, "utf-8");
          input = raw.slice(0, ARTIFACT_TRUNCATE_CHARS);
          if (raw.length > ARTIFACT_TRUNCATE_CHARS) {
            input += `\n\n[... truncated at ${ARTIFACT_TRUNCATE_CHARS} chars ...]`;
          }
          inputSource = "artifact";
        } catch {
          // fall through to fallback
        }
      }

      // Fallback: title + verdictReason
      if (!input) {
        const title = (obj?.payload as Record<string, unknown>)?.title as string ?? "";
        const reason = (_meta.verdictReason as string | undefined) ?? "";
        input = `Title: ${title}\n\nResearch verdict reason: ${reason}`;
        inputSource = "fallback";
      }

      rows.push({
        itemId: obj.id as string,
        title: ((obj?.payload as Record<string, unknown>)?.title as string ?? "").slice(0, 80),
        verdictFromPipeline: _meta.verdict as string,
        artifactPath,
        verdictReason: (_meta.verdictReason as string | undefined) ?? "",
        input,
        inputSource,
      });

      if (rows.length >= MAX_ROWS) break;
    } catch {
      // skip malformed lines
    }
  }

  return rows;
}

// ============================================================================
// Synthetic cases — covers all 3 classes, mirrors real artifact style
// ============================================================================

// These are realistic research-finding summaries written in the same voice and
// structure as real spec-pipeline artifacts. They ensure the golden set has
// coverage across implement / skip / defer even when the live pipeline only
// has `implement` verdicts.

const SYNTHETIC_CASES: SyntheticCase[] = [
  // ── implement (7 cases) ───────────────────────────────────────────────────
  {
    itemId: "syn-impl-001",
    title: "Add retry logic to inference calls on 529 overload",
    input: `Title: Add retry logic to inference calls on 529 overload

Premise Verification: TRUE. Confirmed 3 live occurrences of exit-code 529
in MEMORY/MONITORING/failure-log.jsonl within the last 7 days. Current
lib/core/Inference.ts:88-102 has a 3-strategy JSON extraction retry but no
HTTP-level retry on 529 specifically.

Gap: InferenceResult.success=false propagates silently; callers log and
continue. A 529 is transient (Anthropic overload) — a 2s backoff+retry loop
would recover without human intervention.

Implementation path: add jitter-backoff (max 3 attempts, 2s/4s/8s) inside
the fetchCompletion() inner function before returning failure. No new deps.

Risks: None blocking. The fix is inside a single function boundary.

VERDICT: implement`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-002",
    title: "EventScout: add Songkick tracked-artist feed for Jm",
    input: `Title: EventScout tracked-artist feed integration

Research confirmed: Songkick's /users/jm-stilb/calendar.ics endpoint returns
live ICS data for tracked artists. Jm's account is jm-stilb (RESOLVED).
Current EventScout source list has no Songkick-user-specific feed — only the
metro-area aggregate.

The BrightData unlocker zone (mcp_unlocker) is already wired for Songkick
per EventScout unblock config. Adding a new source entry with
{url, unblock:true, type:'ics'} is the complete diff.

All 391 EventScout tests pass. No new infrastructure needed.

VERDICT: implement — clear deliverable, existing infrastructure, user data confirmed.`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-003",
    title: "LaunchD watchdog: add liveness check for briefing skill",
    input: `Title: Liveness watchdog for DailyBriefing launchd job

Research: DailyBriefing is the highest-visibility cron job (Jm reads it every
morning). Current liveness monitoring only covers: telegram-bot, voice-server,
realtime-voice, mlx-whisper, cron-scheduler. DailyBriefing has NO watchdog.

Evidence of need: StartInterval has fired triple-runs on this machine (3×
08:00) and there is no recovery path when the job wedges silently.

Implementation: add a com.kaya.cron.briefing-liveness plist that runs at
08:30 daily, checks the MEMORY/BRIEFINGS/last-briefing-sent.json timestamp,
and pages via AlertGate if stale >24h. Pattern is identical to
bin/kaya-watchdog.sh (already tested).

No blocking dependencies. Plist generation is deterministic via rebuild-plists.sh.

VERDICT: implement`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-004",
    title: "LucidTasks: archive completed tasks older than 90 days",
    input: `Title: Auto-archive completed LucidTasks older than 90 days

Premise: TRUE. lucidtasks.db currently has 847 rows in status='done' with
no archival mechanism. Oldest completed tasks date to 2025-03-14.

Query confirmed: SELECT count(*) FROM tasks WHERE status='done'
AND completed_at < date('now','-90 days') → 312 rows.

Impact: board rendering scans all rows; 312 stale-done rows add ~40ms to
board load on each Telegram /tasks call (measured via SQLite EXPLAIN).

Implementation: daily cron step that moves done tasks to tasks_archive table
(same schema + archived_at timestamp). Reversible. Pattern from AppUsage
event archival exists (EventArchiver.ts).

VERDICT: implement`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-005",
    title: "WorkQueue: emit audit event on status transition",
    input: `Title: WorkQueue status-transition audit events

Research: MEMORY/MONITORING/audit/ has an interventions.jsonl and
monitor-audit.jsonl but no queue-state-change log. When items get
silently stuck (blocked→pending is a known failure mode), there is no trail.

Gap confirmed: WorkQueue.ts transitions status via a single setStatus()
function (line 145) with no side-effect. Adding appendFileSync to
MEMORY/MONITORING/audit/queue-transitions.jsonl on every call is a
2-line change.

All existing WorkQueue tests cover the status machine; no test changes needed
for the new side-effect (it is fire-and-forget, failure-safe).

VERDICT: implement`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-006",
    title: "Graph: prune edges older than 180 days with no referencing nodes",
    input: `Title: Knowledge graph edge pruning for stale orphan edges

Premise: TRUE. MEMORY/GRAPH/edges/ jsonl files contain 2,841 total edges.
GraphQuerier.ts prune command exists as a stub (line 298: "TODO: implement pruning").
41% of edges reference node IDs that no longer appear in nodes/ jsonl files
(orphan edges confirmed via join script run live).

Orphan edges cause RelationInferrer to emit false positives on re-ingest
because the edges appear valid but lack backing nodes.

Implementation path: bun GraphQuerier.ts prune --older-than 180d
-- reads edges/, joins against node IDs, writes filtered set back.
Existing jsonl-rewrite pattern (used by VaultRefresh) is the model.

VERDICT: implement`,
    origin: "synthetic",
  },
  {
    itemId: "syn-impl-007",
    title: "Anki: add ContinualLearning pipeline integration",
    input: `Title: Wire ContinualLearning into Anki daily review data

Research: ContinualLearning skill has a pipeline stub in
skills/Life/ContinualLearning/Workflows/ that reads from multiple sources
to surface learning items for daily briefing. The Anki skill has a
due-cards CLI verb (AnkiClient.ts:44 --due) that returns today's review cards.

Gap: ContinualLearning.ts has zero Anki references (grep confirmed). The
daily briefing reads habit_log and GOALS.md but never surfaces Anki due counts.

A small adapter (20-30 lines) calling AnkiClient.ts --due and injecting
results into the ContinualLearning pipeline would close this gap.

apy is now installed (pip install apy was the blocker — resolved in
mp2upbd0 implementation). No new infrastructure.

VERDICT: implement`,
    origin: "synthetic",
  },

  // ── skip (6 cases) ────────────────────────────────────────────────────────
  {
    itemId: "syn-skip-001",
    title: "Add JSON output flag to kaya-cli sheets read",
    input: `Title: Add --json flag to kaya-cli sheets read command

Research: premise FALSE. kaya-cli sheets read already supports --json as
a documented flag (kaya-cli.ts:312 --json, outputs raw JSON array).
The flag has been in place since the sheets rewrite (commit 8f3b2a1).

No gap exists. This item is a duplicate of functionality already shipped.
Closing as already solved.

VERDICT: skip`,
    origin: "synthetic",
  },
  {
    itemId: "syn-skip-002",
    title: "EventScout: cache Eventbrite results to reduce fetch latency",
    input: `Title: Cache Eventbrite results between queries

Research: premise partially FALSE. EventScout already caches Eventbrite
responses. EventbriteFetcher.ts:88-103 writes to a local cache file with
a 6-hour TTL. The cache is read on every query before hitting the API.

The live latency the user observed (+30-90s) is from the highValue=true
flag on the eventbrite-sd source, which deliberately bypasses cache for
freshness. This is the intended behavior (decision documented in
project_eventscout_eventbrite_pagination_tradeoff.md).

Building a second cache layer would either be a no-op or would undermine
the freshness guarantee Jm chose. Nothing to implement.

VERDICT: skip`,
    origin: "synthetic",
  },
  {
    itemId: "syn-skip-003",
    title: "Add rate-limit check to AutonomousWork before spawning agents",
    input: `Title: Pre-spawn rate-limit gate for AutonomousWork

Premise: FALSE. WorkOrchestrator.ts:209-231 already reads
MEMORY/State/rate-limits.json before spawning agents. If fiveHour usage
exceeds 90%, it logs a warning and skips the spawn. The logic was added
in commit a3f19b2 (feat(aw): rate-limit guard).

This is exactly the behavior described in the request. No gap.

VERDICT: skip`,
    origin: "synthetic",
  },
  {
    itemId: "syn-skip-004",
    title: "DailyBriefing: surface overdue LucidTasks in morning briefing",
    input: `Title: Add overdue tasks section to DailyBriefing

Research: premise FALSE — this feature already exists.
BriefingBuilder.ts:156-189 queries TaskDB for tasks with
due_date < today() and status != 'done', formats them as a
"⚠️ Overdue" section in the Telegram message. The section fires only
when overdue tasks exist (conditional block at :183).

Live confirmation: today's briefing (2026-06-18 08:00) includes an overdue
section with 2 tasks. The feature is working.

VERDICT: skip`,
    origin: "synthetic",
  },
  {
    itemId: "syn-skip-005",
    title: "Inference.ts: add model fallback when claude-sonnet-4-6 unavailable",
    input: `Title: Model fallback chain for Inference.ts

Research: current Inference.ts already implements a 3-level fallback
(fast=haiku, standard=sonnet, smart=opus). When a model returns 503 or
529, the existing retry logic (3 attempts) handles transient unavailability.
A permanent model-unavailability event (model deprecated/removed) would
require a config change regardless — there is no automated fallback that
could handle this safely without human intervention on model selection.

The proposed feature addresses a non-existent gap: the retry covers
transient overloads; permanent unavailability is a config-change concern.
Building an automatic model-swap would silently change cost/capability
profiles — a hazard worse than the problem.

VERDICT: skip`,
    origin: "synthetic",
  },
  {
    itemId: "syn-skip-006",
    title: "WorkQueue: add item-count telemetry to MEMORY/MONITORING",
    input: `Title: WorkQueue size telemetry

Research: WorkQueue already emits size metrics. WorkOrchestrator.ts:338-342
writes a metrics snapshot to MEMORY/MONITORING/cron-health-state.json on
every orchestration cycle including: queue_size, in_progress_count,
blocked_count, completed_today. The health monitor at
MEMORY/AutoMaintenance/health-state.json also records these fields hourly.

No gap. The telemetry is already there; the data just lives in a file
the user hadn't checked. No code needed.

VERDICT: skip`,
    origin: "synthetic",
  },

  // ── defer (6 cases) ───────────────────────────────────────────────────────
  {
    itemId: "syn-defer-001",
    title: "Migrate TaskDB from SQLite to Postgres for multi-device sync",
    input: `Title: TaskDB Postgres migration for multi-device access

Premise: TRUE — the need for multi-device access is real. Jm's iPad cannot
reach lucidtasks.db (file-only SQLite). However:

BLOCKED: The IV build Supabase migration SSL lessons (sslmode=verify-full
+ CA cert requirement, SELF_SIGNED_CERT_IN_CHAIN gotcha) apply here.
A clean Postgres migration requires:
  1. Prod Supabase project — not yet created for Kaya (IV project is separate).
  2. Migration script for lucidtasks.db schema (0-downtime, additive).
  3. Column-level grant strategy (app_rw pattern from IV applies).

None of these prerequisites exist. Building now would mean migrating to
an unprovisioned DB, which is guaranteed to fail at first launchd fire.

Revisit: once a Kaya Supabase project is provisioned and the migration
tooling from IV is adapted (est. Q3 2026).

VERDICT: defer`,
    origin: "synthetic",
  },
  {
    itemId: "syn-defer-002",
    title: "Kaya v3: rebuild as separate repo",
    input: `Title: Kaya v3 Ground-up rebuild

Premise: TRUE on all three architectural principles. However:

BLOCKED by ADR-0001 (skills/Automation/AutonomousWork/docs/adr/0001-slice-based-hybrid-retrofit.md)
which explicitly rejected wholesale Ralph-loop adoption and chose incremental
retrofit. The retrofit plan (S4+S6 done, S1-S3 remaining) is in-flight.
Additionally, Plans/Specs/Queue/mnt5gb50-th7itl-spec.md (approved, awaiting
build) invests further in the current architecture.

Building a parallel rebuild now would create two diverging codebases with
no clear migration path. The ADR conflict is a decision-gate that Jm
must resolve before any rebuild work starts.

Prerequisite: close the retrofit, revisit ADR-0001, then scope v3.

VERDICT: defer`,
    origin: "synthetic",
  },
  {
    itemId: "syn-defer-003",
    title: "Add AnkiConnect transport to AnkiClient as primary path",
    input: `Title: AnkiConnect HTTP transport for AnkiClient

Premise: TRUE. AnkiConnect addon 2055492159 is installed in Anki.app
and serves localhost:8765. Current AnkiClient.ts is apy-only, and apy
requires Anki.app closed during writes (file-lock conflict). AnkiConnect
requires Anki.app open. These two transports are mutually exclusive in
practice.

BLOCKED: AnkiClient.ts is currently being refactored in the mp2upbd0
implementation (Anki cards for cooking — in_progress as of 2026-06-12).
Adding a new transport path while the client is being rewritten mid-flight
would cause a merge conflict that could corrupt the card-import workflow.

Correct approach: let mp2upbd0 land first, then add AnkiConnect as a
transport option in a follow-on item. The follow-on is obvious and worth
doing; the timing is wrong now.

VERDICT: defer`,
    origin: "synthetic",
  },
  {
    itemId: "syn-defer-004",
    title: "EventScout: integrate Ticketmaster API for venue events",
    input: `Title: Ticketmaster API integration for EventScout

Premise: TRUE — Ticketmaster covers SD venues not on Eventbrite/Songkick.
However:

BLOCKED: Ticketmaster's Discovery API requires OAuth 2.0 app approval
(reviewed manually, avg 2-3 weeks). API key request submitted 2026-06-01;
no approval yet as of research date (2026-06-18). Without credentials
there is no integration to build.

The integration pattern (ICS or JSON → EventSource adapter) is well-understood
from existing sources. The blocker is purely the external vendor credential.

Revisit: once API credentials are approved and rotated into secrets.json.

VERDICT: defer`,
    origin: "synthetic",
  },
  {
    itemId: "syn-defer-005",
    title: "Voice interaction: add real-time transcript streaming to Telegram",
    input: `Title: Live voice transcript streaming to Telegram

Premise: TRUE — sending live partial transcripts to Telegram during voice
sessions would let Jm review what Kaya heard before she responds.

BLOCKED: The current voice pipeline uses a batch transcript model
(mlx-whisper segments after sentence boundaries). Streaming partial tokens
to Telegram requires:
  1. WebSocket connection from RealtimeVoiceServer.ts to the Telegram bot
     (no current channel — they communicate only via MEMORY/ files).
  2. Telegram rate-limit handling for high-frequency message sends (4 msg/s
     limit applies; partial transcripts would need debouncing).

Neither the IPC channel nor the debounce logic exists. This is a non-trivial
infrastructure addition that should follow, not precede, the voice-server
WebSocket refactor currently planned for Q3.

VERDICT: defer`,
    origin: "synthetic",
  },
  {
    itemId: "syn-defer-006",
    title: "Canvas v2 Loop 2: content scheduling and publishing",
    input: `Title: Canvas v2 Loop 2 — Content Scheduling

Premise: TRUE and scoped. Canvas v2 Loop 1 (Mission Control, ISC 1-9)
was built and self-verified live. Loop 2 (content scheduling + publishing)
is the documented next phase in skills/Development/Canvas/CONTEXT.md.

BLOCKED: Loop 1 merge and formal Phase-L gate are deferred to an authorized
run (the worktree item is blocked on purpose). Until Loop 1 ships and is
stable, building Loop 2 on top of it creates a dependency on moving ground.

Implementation path is clear once Loop 1 lands: the scheduling pattern from
DailyBriefing and the publishing transport from the Telegram skill are
the primary building blocks.

VERDICT: defer`,
    origin: "synthetic",
  },
];

// ============================================================================
// Ensemble labeler
// ============================================================================

type InferenceLevel = "fast" | "standard" | "smart";
const LEVELS: InferenceLevel[] = ["fast", "standard", "smart"];

interface EnsembleResult {
  label: string | null;
  divergent: boolean;
  votes: Record<string, number>;
}

async function ensembleLabel(input: string): Promise<EnsembleResult> {
  const rawResults = await Promise.all(
    LEVELS.map((level) =>
      inference({
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        userPrompt: input,
        level,
        expectJson: true,
        retries: 2,
      })
    )
  );

  const votes: Record<string, number> = {};
  let voterCount = 0;

  for (const result of rawResults) {
    const raw =
      result.success && result.parsed != null
        ? (result.parsed as Record<string, unknown>)[CANDIDATE_FIELD]
        : undefined;

    if (typeof raw === "string" && VALID_VERDICTS.has(raw)) {
      votes[raw] = (votes[raw] ?? 0) + 1;
      voterCount++;
    }
  }

  if (voterCount === 0) {
    return { label: null, divergent: true, votes };
  }

  let topLabel: string | undefined;
  let topCount = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > topCount) {
      topCount = count;
      topLabel = label;
    }
  }

  const hasMajority = topLabel !== undefined && topCount * 2 > voterCount;

  if (hasMajority && topLabel !== undefined) {
    return { label: topLabel, divergent: false, votes };
  }

  return { label: null, divergent: true, votes };
}

// ============================================================================
// Main
// ============================================================================

const isDryRun = process.argv.includes("--dry-run");

// Load real rows from spec-pipeline.jsonl
const realRows = loadRealRows();
const artifactCount = realRows.filter((r) => r.inputSource === "artifact").length;
const fallbackCount = realRows.filter((r) => r.inputSource === "fallback").length;

// Combine real + synthetic
interface LabelableCase {
  itemId: string;
  title: string;
  input: string;
  origin: "real" | "synthetic";
  inputSource?: "artifact" | "fallback";
}

const allCases: LabelableCase[] = [
  ...realRows.map((r) => ({
    itemId: r.itemId,
    title: r.title,
    input: r.input,
    origin: "real" as const,
    inputSource: r.inputSource,
  })),
  ...SYNTHETIC_CASES.map((s) => ({
    itemId: s.itemId,
    title: s.title,
    input: s.input,
    origin: "synthetic" as const,
    inputSource: undefined,
  })),
];

const totalCalls = allCases.length * LEVELS.length;

console.log(`\n=== Research Verdict Golden Labeler ===`);
console.log(`Real pipeline rows:  ${realRows.length} (${artifactCount} artifact, ${fallbackCount} fallback)`);
console.log(`Synthetic cases:     ${SYNTHETIC_CASES.length}`);
console.log(`Total cases:         ${allCases.length}`);
console.log(`Levels:              ${LEVELS.join(", ")} (${totalCalls} total inference calls)`);
console.log(`Output:              ${OUTPUT_PATH}`);
console.log(`Mode:                ${isDryRun ? "DRY-RUN (no LLM calls)" : "LIVE"}\n`);

if (isDryRun) {
  console.log("Cases (dry-run):");
  allCases.forEach((c, i) =>
    console.log(`  ${i + 1}. [${c.origin}] ${c.itemId} — ${c.title.slice(0, 60)}`)
  );
  process.exit(0);
}

// Run labeling
const lines: string[] = [];
let consensusCount = 0;
let divergentCount = 0;
const distributionMap: Record<string, number> = {};
const labeledAt = new Date().toISOString();

console.log("Labeling cases...\n");

for (let i = 0; i < allCases.length; i++) {
  const c = allCases[i];
  process.stdout.write(
    `[${i + 1}/${allCases.length}] [${c.origin}] ${c.itemId.slice(0, 20)} — ${c.title.slice(0, 50)}${c.title.length > 50 ? "…" : ""} `
  );

  try {
    const result = await ensembleLabel(c.input);

    if (result.divergent) {
      divergentCount++;
      process.stdout.write(`→ DIVERGENT (votes: ${JSON.stringify(result.votes)})\n`);
      lines.push(
        JSON.stringify({
          itemId: c.itemId,
          title: c.title,
          verdict: null,
          divergent: true,
          votes: result.votes,
          source: "ensemble",
          origin: c.origin,
          ...(c.inputSource ? { inputSource: c.inputSource } : {}),
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    } else {
      consensusCount++;
      const verdict = result.label!;
      distributionMap[verdict] = (distributionMap[verdict] ?? 0) + 1;
      process.stdout.write(`→ ${verdict}\n`);
      lines.push(
        JSON.stringify({
          itemId: c.itemId,
          title: c.title,
          verdict,
          source: "ensemble",
          origin: c.origin,
          ...(c.inputSource ? { inputSource: c.inputSource } : {}),
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    divergentCount++;
    process.stdout.write(`→ ERROR: ${msg}\n`);
    lines.push(
      JSON.stringify({
        itemId: c.itemId,
        title: c.title,
        verdict: null,
        divergent: true,
        error: msg,
        source: "ensemble",
        origin: c.origin,
        ...(c.inputSource ? { inputSource: c.inputSource } : {}),
        labeled_at: labeledAt,
        criteria_version: CRITERIA_VERSION,
      })
    );
  }
}

// Write output
const outputDir = dirname(OUTPUT_PATH);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n", "utf-8");

// Report
console.log(`\n=== Results ===`);
console.log(`Total:      ${allCases.length}`);
console.log(`Consensus:  ${consensusCount}`);
console.log(`Divergent:  ${divergentCount}`);
console.log(`\nPer-verdict distribution (consensus cases):`);
for (const [verdict, count] of Object.entries(distributionMap).sort()) {
  console.log(`  ${verdict.padEnd(12)} ${count}`);
}
console.log(`\nArtifact sourcing:`);
console.log(`  On-disk artifacts: ${artifactCount}`);
console.log(`  Fallback (title+reason): ${fallbackCount}`);
console.log(`  Synthetic cases: ${SYNTHETIC_CASES.length}`);
console.log(`\nGolden set written to: ${OUTPUT_PATH}`);
