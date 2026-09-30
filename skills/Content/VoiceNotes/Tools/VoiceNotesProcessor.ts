#!/usr/bin/env bun
/**
 * VoiceNotesProcessor.ts — transcribe mobile & desktop voice notes into Obsidian.
 *
 * Pipeline (per new audio file found in a source folder):
 *   1. transcribe  — extract-transcript.py (faster-whisper, local)
 *   2. organize    — LLM cleans the transcript and routes it to a vault folder
 *   3. write       — a structured Obsidian note (frontmatter + summary + body
 *                    + action items + collapsible raw transcript)
 *   4. archive     — move the audio out of the inbox; record it in the ledger
 *
 * Idempotent: every file is keyed by a content hash, so re-runs and renamed
 * files are never double-processed. Originals are archived, never deleted.
 *
 * Usage:
 *   bun VoiceNotesProcessor.ts scan                 # list pending audio files
 *   bun VoiceNotesProcessor.ts run [--dry-run] [--model large-v3] [--keep-audio]
 *   bun VoiceNotesProcessor.ts process-file <path>  # process a single file
 *   bun VoiceNotesProcessor.ts status               # ledger stats
 */

import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "fs";
import { createHash } from "crypto";
import { basename, dirname, extname, join } from "path";
import { tmpdir } from "os";
import { inference } from "../../../../lib/core/Inference.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
import {
  loadConfig,
  KAYA_HOME,
  SUPPORTED_EXTENSIONS,
  type VoiceNotesConfig,
} from "./config.ts";

const EXTRACT_SCRIPT = join(KAYA_HOME, "lib", "core", "extract-transcript.py");

// ============================================================
// Ledger
// ============================================================

interface LedgerEntry {
  hash: string;
  originalName: string;
  notePath: string;
  archivedPath?: string;
  processedAt: string;
  device: string;
}

interface Ledger {
  processed: Record<string, LedgerEntry>;
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return { processed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Ledger;
    if (!parsed.processed) parsed.processed = {};
    return parsed;
  } catch {
    return { processed: {} };
  }
}

export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), "utf-8");
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "voice-note";
}

/** Infer capture device from the source folder path. */
export function inferDevice(sourcePath: string): "mobile" | "desktop" | "unknown" {
  const p = sourcePath.toLowerCase();
  if (p.includes("mobile documents") || p.includes("clouddocs")) return "mobile";
  if (p.includes("voicememos")) return "unknown";
  return "desktop";
}

/** Best-effort audio duration in seconds via macOS `afinfo`, else undefined. */
export function probeDurationSec(path: string): number | undefined {
  const r = spawnSync("afinfo", [path], { encoding: "utf-8", timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const m = r.stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i);
  if (m) return Math.round(parseFloat(m[1]));
  return undefined;
}

export interface Organized {
  title: string;
  category: string;
  summary: string;
  tags: string[];
  cleaned: string;
  actionItems: string[];
  links: string[];
}

export interface NoteMeta {
  title: string;
  createdISO: string;
  audioName: string;
  durationSec?: number;
  device: string;
  model: string;
}

/** Render the final Obsidian note markdown. */
export function buildNote(org: Organized, raw: string, meta: NoteMeta): string {
  const tags = Array.from(new Set(["voice-note", ...org.tags.map((t) => t.replace(/^#/, ""))]));
  const fm: string[] = [
    "---",
    `title: ${JSON.stringify(org.title)}`,
    `created: ${meta.createdISO}`,
    "source: voice-note",
    `device: ${meta.device}`,
    `audio: ${JSON.stringify(meta.audioName)}`,
  ];
  if (typeof meta.durationSec === "number") fm.push(`duration_sec: ${meta.durationSec}`);
  fm.push(`transcription_model: ${meta.model}`);
  fm.push(`tags: [${tags.join(", ")}]`);
  fm.push("---", "");

  const body: string[] = [`# ${org.title}`, ""];
  if (org.summary) body.push(`> [!summary] ${org.summary}`, "");
  if (org.cleaned) body.push(org.cleaned.trim(), "");

  if (org.actionItems.length) {
    body.push("## Action Items", "");
    for (const item of org.actionItems) body.push(`- [ ] ${item}`);
    body.push("");
  }

  if (org.links.length) {
    body.push("## Related", "");
    for (const link of org.links) {
      const wl = /^\[\[.*\]\]$/.test(link) ? link : `[[${link.replace(/^\[\[|\]\]$/g, "")}]]`;
      body.push(`- ${wl}`);
    }
    body.push("");
  }

  body.push(
    "## Raw Transcript",
    "",
    "> [!note]- Original transcription",
    raw.trim().split("\n").map((l) => `> ${l}`).join("\n"),
    "",
  );

  return fm.join("\n") + body.join("\n");
}

/** Resolve the on-disk note path, sanitizing the category against the vault. */
export function resolveNotePath(
  cfg: VoiceNotesConfig,
  validCategories: string[],
  category: string,
  title: string,
  createdISO: string,
): string {
  const safeCategory = validCategories.includes(category) ? category : cfg.defaultCategory;
  const date = createdISO.slice(0, 10);
  const slug = slugify(title);
  const dir = join(cfg.vaultPath, safeCategory, cfg.noteSubfolder);
  return join(dir, `${date}-${slug}.md`);
}

/** Avoid clobbering: append -2, -3, ... if a note path already exists. */
export function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

/** List vault top-level folders usable as routing categories. */
export function vaultCategories(vaultPath: string): string[] {
  if (!existsSync(vaultPath)) return [];
  return readdirSync(vaultPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

/** Safe move across devices (rename, falling back to copy+unlink). */
function moveFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

// ============================================================
// Discovery
// ============================================================

export interface PendingFile {
  path: string;
  source: string;
  device: string;
}

export function discoverPending(cfg: VoiceNotesConfig, ledger: Ledger): PendingFile[] {
  const pending: PendingFile[] = [];
  const seenHashes = new Set(Object.keys(ledger.processed));
  for (const source of cfg.sources) {
    if (!existsSync(source)) continue;
    let entries: string[];
    try {
      entries = readdirSync(source);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(source, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      let hash: string;
      try {
        hash = hashFile(full);
      } catch {
        continue;
      }
      if (seenHashes.has(hash)) continue;
      pending.push({ path: full, source, device: inferDevice(source) });
    }
  }
  return pending;
}

// ============================================================
// Transcription
// ============================================================

export function transcribe(audioPath: string, model: string): string {
  const workDir = join(tmpdir(), "voicenotes-stt");
  mkdirSync(workDir, { recursive: true });
  const r = spawnSync(
    "uv",
    ["run", EXTRACT_SCRIPT, audioPath, "--model", model, "--format", "txt", "--output", workDir],
    { encoding: "utf-8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`Transcription failed: ${r.stderr || r.stdout || "unknown error"}`);
  }
  const base = basename(audioPath, extname(audioPath));
  const txtPath = join(workDir, `${base}.txt`);
  if (!existsSync(txtPath)) {
    throw new Error(`Transcript not produced for ${audioPath}`);
  }
  const text = readFileSync(txtPath, "utf-8").trim();
  try {
    unlinkSync(txtPath);
  } catch {
    /* ignore */
  }
  return text;
}

// ============================================================
// Organize (LLM)
// ============================================================

export function buildOrganizePrompt(categories: string[]): string {
  return [
    "You organize Jm's spoken voice notes into his Obsidian vault.",
    "You are given a raw speech-to-text transcript (it may contain filler words,",
    "false starts, and transcription errors). Produce clean, useful notes.",
    "",
    "Return STRICT JSON only, no prose, with this shape:",
    "{",
    '  "title": "concise descriptive title (no date)",',
    '  "category": "ONE folder from the allowed list, or \\"Voice Notes\\" if none fit",',
    '  "summary": "one or two sentence summary",',
    '  "tags": ["lowercase-hyphenated", "topical tags"],',
    '  "cleaned": "the note body in markdown — lightly cleaned (fix obvious STT',
    '             errors, remove filler, add paragraphs/bullets) but keep Jm\'s",',
    '             meaning and voice; do NOT invent content",',
    '  "actionItems": ["any explicit to-dos or follow-ups mentioned"],',
    '  "links": ["Suggested [[wikilink]] targets, bare titles ok; [] if none"]',
    "}",
    "",
    "Choose the single best-fitting category. Allowed vault folders:",
    categories.map((c) => `- ${c}`).join("\n"),
    "",
    'If the transcript is too short or empty to be meaningful, still return valid JSON',
    'with category "Voice Notes" and the transcript echoed in "cleaned".',
  ].join("\n");
}

function fallbackOrganize(raw: string, audioName: string): Organized {
  const firstLine = raw.split(/[.\n]/)[0]?.trim().slice(0, 60) || basename(audioName, extname(audioName));
  return {
    title: firstLine || "Voice Note",
    category: "Voice Notes",
    summary: "",
    tags: ["needs-review"],
    cleaned: raw,
    actionItems: [],
    links: [],
  };
}

export async function organize(
  raw: string,
  categories: string[],
  audioName: string,
  level: VoiceNotesConfig["inferenceLevel"],
): Promise<Organized> {
  if (!raw.trim()) return fallbackOrganize("(empty transcription)", audioName);

  const result = await inference({
    systemPrompt: buildOrganizePrompt(categories),
    userPrompt: `Transcript:\n\n${raw}`,
    level,
    expectJson: true,
    timeout: 90000,
    retries: 1,
  });

  if (result.success && result.parsed && typeof result.parsed === "object") {
    const p = result.parsed as Partial<Organized>;
    return {
      title: (p.title || "").trim() || fallbackOrganize(raw, audioName).title,
      category: (p.category || "Voice Notes").trim(),
      summary: (p.summary || "").trim(),
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string") : [],
      cleaned: (p.cleaned || raw).trim(),
      actionItems: Array.isArray(p.actionItems)
        ? p.actionItems.filter((t) => typeof t === "string")
        : [],
      links: Array.isArray(p.links) ? p.links.filter((t) => typeof t === "string") : [],
    };
  }

  console.error(`[VoiceNotes] LLM organize failed (${result.error || "no parse"}); using fallback.`);
  return fallbackOrganize(raw, audioName);
}

// ============================================================
// Per-file processing
// ============================================================

export interface ProcessResult {
  file: string;
  notePath: string;
  archivedPath?: string;
  category: string;
  durationSec?: number;
  dryRun: boolean;
}

export async function processFile(
  filePath: string,
  cfg: VoiceNotesConfig,
  ledger: Ledger,
  opts: { dryRun?: boolean; device?: string } = {},
): Promise<ProcessResult> {
  const dryRun = !!opts.dryRun;
  const device = opts.device || inferDevice(dirname(filePath));
  const audioName = basename(filePath);
  const hash = hashFile(filePath);

  console.error(`\n→ ${audioName} (${device})`);
  console.error(`  transcribing with ${cfg.whisperModel}…`);
  const raw = transcribe(filePath, cfg.whisperModel);
  console.error(`  ${raw.length} chars transcribed`);

  const categories = vaultCategories(cfg.vaultPath);
  const org = await organize(raw, categories, audioName, cfg.inferenceLevel);
  console.error(`  organized → ${org.category} / "${org.title}"`);

  const createdISO = new Date(statSync(filePath).mtime).toISOString();
  const durationSec = probeDurationSec(filePath);

  const notePath = uniquePath(
    resolveNotePath(cfg, categories, org.category, org.title, createdISO),
  );
  const safeCategory = categories.includes(org.category) ? org.category : cfg.defaultCategory;

  // Archive destination: preserve original name, keyed by date for uniqueness.
  const archivedPath = uniquePath(
    join(cfg.archiveDir, `${createdISO.slice(0, 10)}-${audioName}`),
  );

  const note = buildNote(org, raw, {
    title: org.title,
    createdISO,
    audioName: cfg.keepAudio ? audioName : basename(archivedPath),
    durationSec,
    device,
    model: cfg.whisperModel,
  });

  if (dryRun) {
    console.error(`  [dry-run] would write ${notePath}`);
    return { file: filePath, notePath, category: safeCategory, durationSec, dryRun };
  }

  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, note, "utf-8");
  console.error(`  wrote ${notePath}`);

  let finalArchived: string | undefined;
  if (!cfg.keepAudio) {
    moveFile(filePath, archivedPath);
    finalArchived = archivedPath;
    console.error(`  archived audio → ${archivedPath}`);
  }

  ledger.processed[hash] = {
    hash,
    originalName: audioName,
    notePath,
    archivedPath: finalArchived,
    processedAt: new Date().toISOString(),
    device,
  };
  saveLedger(cfg.ledgerPath, ledger);

  return { file: filePath, notePath, archivedPath: finalArchived, category: safeCategory, durationSec, dryRun };
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "run";
  const cfg = loadConfig();

  // Flag overrides
  const dryRun = args.includes("--dry-run");
  if (args.includes("--keep-audio")) cfg.keepAudio = true;
  const modelIdx = args.indexOf("--model");
  if (modelIdx >= 0 && args[modelIdx + 1]) cfg.whisperModel = args[modelIdx + 1];

  const ledger = loadLedger(cfg.ledgerPath);

  if (cmd === "scan") {
    const pending = discoverPending(cfg, ledger);
    console.log(`Sources:\n${cfg.sources.map((s) => `  ${existsSync(s) ? "✓" : "·"} ${s}`).join("\n")}`);
    console.log(`\nPending (${pending.length}):`);
    for (const p of pending) console.log(`  ${p.device.padEnd(7)} ${p.path}`);
    if (!pending.length) console.log("  (none)");
    return;
  }

  if (cmd === "status") {
    const entries = Object.values(ledger.processed);
    console.log(`Processed notes: ${entries.length}`);
    console.log(`Ledger: ${cfg.ledgerPath}`);
    console.log(`Archive: ${cfg.archiveDir}`);
    for (const e of entries.slice(-10)) {
      console.log(`  ${e.processedAt.slice(0, 19)}  ${e.device.padEnd(7)}  ${e.notePath}`);
    }
    return;
  }

  if (cmd === "process-file") {
    const file = args[1];
    if (!file || !existsSync(file)) {
      console.error("Usage: process-file <existing-audio-path>");
      process.exit(1);
    }
    const res = await processFile(file, cfg, ledger, { dryRun });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  // default: run
  const pending = discoverPending(cfg, ledger);
  if (!pending.length) {
    console.log("No new voice notes to process.");
    return;
  }
  console.log(`Processing ${pending.length} voice note(s)…`);
  const results: ProcessResult[] = [];
  const failures: { file: string; error: string }[] = [];
  for (const p of pending) {
    try {
      results.push(await processFile(p.path, cfg, ledger, { dryRun, device: p.device }));
    } catch (err) {
      const message = (err as Error).message;
      console.error(`✗ ${p.path}: ${message}`);
      failures.push({ file: p.path, error: message });
      // WRITE — must not be silent: this is the forensic record kaya-watchdog.sh
      // Check 3 scans by timestamp. logFailure() never throws (see FailureLog.ts
      // doc comment), so no additional try/catch is needed here.
      logFailure("VoiceNotes:run", err, { file: p.path, device: p.device });
    }
  }
  console.log(`\nDone. ${results.length}/${pending.length} processed${dryRun ? " (dry-run)" : ""}.`);
  for (const r of results) console.log(`  ${r.category} → ${r.notePath}`);
  if (failures.length > 0) {
    console.error(`${failures.length}/${pending.length} file(s) failed — see above.`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
