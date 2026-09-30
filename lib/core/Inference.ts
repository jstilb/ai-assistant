#!/usr/bin/env bun
/**
 * ============================================================================
 * INFERENCE - Unified inference tool with three run levels
 * ============================================================================
 *
 * PURPOSE:
 * Single inference tool with configurable speed/capability trade-offs:
 * - Fast: Haiku - quick tasks, simple generation, basic classification
 * - Standard: Sonnet - balanced reasoning, typical analysis
 * - Smart: Opus - deep reasoning, strategic decisions, complex analysis
 * - Kimi: Kimi K3 (Moonshot) - 1M-token context, non-Anthropic second opinion
 *
 * USAGE:
 *   bun Inference.ts --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --level standard <system_prompt> <user_prompt>
 *   bun Inference.ts --level smart <system_prompt> <user_prompt>
 *   bun Inference.ts --level kimi <system_prompt> <user_prompt>
 *   bun Inference.ts --json --level fast <system_prompt> <user_prompt>
 *
 * OPTIONS:
 *   --level <fast|standard|smart|kimi>  Run level (default: standard)
 *   --json                              Expect and parse JSON response (regex-scrape fallback)
 *   --schema <json-schema>              Schema-constrained structured output via
 *                                       `claude --json-schema` (validated at the API
 *                                       level; preferred over --json; not on kimi)
 *   --timeout <ms>                      Custom timeout (default varies by level)
 *
 * DEFAULTS BY LEVEL:
 *   fast:     model=haiku,   timeout=60s
 *   standard: model=sonnet,  timeout=240s
 *   smart:    model=opus,    timeout=240s
 *   kimi:     model=kimi-k3, timeout=240s
 *
 * BILLING:
 *   fast/standard/smart — Claude CLI on Jm's subscription (no API key, no
 *     per-call charge).
 *   kimi — METERED Moonshot API key ($3/M in, $15/M out as of 2026-07-24).
 *     Every call costs real money, so `kimi` is opt-in per call and is never
 *     a fallback for a failed Claude level. Requires MOONSHOT_API_KEY in
 *     secrets.json; absent key fails loud (see MoonshotClient.ts).
 *
 * SCOPE NOTE: `kimi` is an inference tier only — one-shot prompt→text with no
 * tools. Kaya sub-agents are `claude -p` processes carrying the Claude Code
 * tool harness, which Moonshot's API does not provide; agentic Kimi would be a
 * separate build (see AgentSpawner.ts).
 *
 * ============================================================================
 */

import { spawn, execSync } from "child_process";
import { existsSync, openSync, closeSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { loadTieredConfig } from "./ConfigLoader.ts";
import { getKayaHome, defaultKayaHome } from "./KayaHome.ts";
import { moonshotChat, KIMI_K3_MODEL, KIMI_K3_PRICING } from "./MoonshotClient.ts";
import { z } from "zod";

/**
 * Read CLAUDE_CODE_OAUTH_TOKEN from ~/.claude/secrets.json (cached).
 * Used to inject auth into spawned `claude -p` subprocesses when interactive
 * Claude Code sessions don't inherit it from the shell env.
 * Returns undefined if secrets.json is missing/malformed/lacks the token.
 *
 * Cache invalidation: the module-level cache is discarded whenever secrets.json
 * mtime advances (e.g. after keychain-acl-watcher syncs a fresh login token).
 * Long-running processes pick up the updated token on their next call without
 * needing a restart. Fail-open on any fs error.
 */
let _oauthTokenCache: string | null | undefined;
let _oauthTokenCacheMtime: number | null = null;
let _oauthTokenCachePath: string | null = null;
export function loadOAuthToken(): string | undefined {
  const secretsPath = join(getKayaHome(), 'secrets.json');

  // Path-keyed: a KAYA_HOME override mid-process resolves a different
  // secrets.json — the cached value belongs to the old path, discard it.
  if (_oauthTokenCachePath !== null && _oauthTokenCachePath !== secretsPath) {
    _oauthTokenCache = undefined;
    _oauthTokenCacheMtime = null;
  }

  // Mtime-based invalidation: if secrets.json was modified since last read,
  // discard the cache so the caller receives the freshly-synced token.
  if (_oauthTokenCache !== undefined && _oauthTokenCacheMtime !== null) {
    try {
      const currentMtime = statSync(secretsPath).mtimeMs;
      if (currentMtime > _oauthTokenCacheMtime) {
        _oauthTokenCache = undefined;
        _oauthTokenCacheMtime = null;
      }
    } catch { /* stat failed (e.g. file deleted) — keep existing cache */ }
  }

  if (_oauthTokenCache !== undefined) return _oauthTokenCache ?? undefined;
  try {
    if (existsSync(secretsPath)) {
      const mtimeMs = statSync(secretsPath).mtimeMs;
      const secrets = JSON.parse(readFileSync(secretsPath, 'utf-8')) as Record<string, unknown>;
      const token = typeof secrets.CLAUDE_CODE_OAUTH_TOKEN === 'string' ? secrets.CLAUDE_CODE_OAUTH_TOKEN : null;
      _oauthTokenCache = token;
      _oauthTokenCacheMtime = mtimeMs;
      _oauthTokenCachePath = secretsPath;
      return token ?? undefined;
    }
  } catch { /* fail open — caller falls back to inherited env */ }
  // Cache the miss with mtime 0 so a secrets.json created LATER (mtime > 0)
  // invalidates it — otherwise the null would be sticky for process lifetime.
  _oauthTokenCache = null;
  _oauthTokenCacheMtime = 0;
  _oauthTokenCachePath = secretsPath;
  return undefined;
}

/**
 * Resolve the full path to the `claude` CLI binary.
 * In interactive shells, `claude` is on $PATH via ~/.local/bin.
 * In background/automated contexts (launchd, cron), $PATH may be minimal,
 * so we check known locations as fallback.
 */
function resolveClaudePath(): string {
  // Known install locations (ordered by likelihood)
  const knownPaths = [
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  // First, try the known paths directly (fastest, no shell needed)
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: try `which` in case it's somewhere else on PATH
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    // Last resort — return bare name and let spawn fail with a clear error
    return 'claude';
  }
}

export const CLAUDE_PATH = resolveClaudePath();

export type InferenceLevel = 'fast' | 'standard' | 'smart' | 'kimi';

/**
 * Levels that do NOT spawn `claude -p`. Currently only `kimi`, which calls
 * Moonshot's OpenAI-compatible HTTPS API with a metered key.
 */
export function isExternalApiLevel(level: InferenceLevel): boolean {
  return level === 'kimi';
}

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  expectJson?: boolean;
  /** JSON Schema for schema-constrained structured output. When set, the
   *  `claude -p` spawn adds `--json-schema` + `--output-format json` and
   *  `parsed` comes from the envelope's validated `structured_output` field —
   *  the model is forced into a tool call at the API level, and extractJson()
   *  never runs. A missing/invalid envelope FAILS LOUD (success:false) instead
   *  of silently returning undefined. Implies structured output; `expectJson`
   *  is ignored when this is set. NOT supported on the `kimi` level (no
   *  claude -p spawn) — that combination fails loud rather than degrading. */
  schema?: Record<string, unknown>;
  timeout?: number;
  /** When true, detect JSON arrays in userPrompt and TOON-encode them before sending.
   *  Only applies when settings.json toon.enableInInference is also true. */
  toonEncodeInput?: boolean;
  /** Number of retry attempts on failure (default 0 = no retry). Each retry
   *  spawns a fresh `claude -p` subprocess with a new TCP connection — this is
   *  what recovers a transient post-wake-from-sleep network stall, which a
   *  longer timeout alone cannot fix (the stalled socket stays dead). */
  retries?: number;
  /** Delay between retry attempts, in ms (default 4000). */
  retryDelayMs?: number;
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
  // Cost estimation fields (always present; 0 on failure)
  estimatedTokens: {
    input: number;
    output: number;
    total: number;
  };
  estimatedCostUSD: number;
}

/** Published per-token pricing by model family (USD per million tokens). */
const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  opus:   { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  sonnet: { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  haiku:  { inputPerMillion: 0.25,  outputPerMillion: 1.25  },
  // Metered Moonshot API — unlike the Claude rows above (subscription-billed),
  // this cost is really charged to Jm's card. Cache-hit input is $0.30/M but we
  // cannot observe cache status per call, so the miss rate is the honest estimate.
  kimi:   { inputPerMillion: KIMI_K3_PRICING.inputPerMillion, outputPerMillion: KIMI_K3_PRICING.outputPerMillion },
};

/**
 * Approximate token count from string length.
 * Uses the widely-accepted 4 chars ≈ 1 token heuristic.
 * Returns 0 for empty strings.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Resolve pricing tier from model name string.
 * Matches by substring: 'claude-3-opus-*' → 'opus', etc.
 * Defaults to sonnet pricing for unknown models.
 */
export function resolveModelPricing(
  modelName: string
): { inputPerMillion: number; outputPerMillion: number } {
  const lower = modelName.toLowerCase();
  if (lower.includes('kimi'))   return MODEL_PRICING['kimi']!;
  if (lower.includes('opus'))   return MODEL_PRICING['opus']!;
  if (lower.includes('sonnet')) return MODEL_PRICING['sonnet']!;
  if (lower.includes('haiku'))  return MODEL_PRICING['haiku']!;
  return MODEL_PRICING['sonnet']!;
}

/**
 * Calculate estimated cost in USD for a single inference call.
 */
export function estimateCostUSD(params: {
  inputTokens: number;
  outputTokens: number;
  modelName: string;
}): number {
  const pricing = resolveModelPricing(params.modelName);
  const inputCost  = (params.inputTokens  / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (params.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}

// Level configuration schema
// Effort per tier (Claude Code `--effort`; low..max). Fable 5.1 / Sonnet 5 /
// Opus 5 default to `high`; the routine one-shot work these tiers serve does
// not need it. Anthropic's Fable 5.1 guidance: low/medium for routine work,
// high for most tasks. Kimi has no effort dial (Moonshot HTTPS path).
const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const LevelConfigSchema = z.object({
  fast: z.object({
    model: z.string().default('haiku'),
    defaultTimeout: z.number().default(60000),
    effort: EffortSchema.default('low'),
  }),
  standard: z.object({
    model: z.string().default('sonnet'),
    defaultTimeout: z.number().default(240000),
    effort: EffortSchema.default('medium'),
  }),
  smart: z.object({
    model: z.string().default('opus'),
    defaultTimeout: z.number().default(240000),
    effort: EffortSchema.default('high'),
  }),
  kimi: z.object({
    model: z.string().default(KIMI_K3_MODEL),
    defaultTimeout: z.number().default(240000),
  }),
});

// Default level configurations
const DEFAULT_LEVEL_CONFIG = {
  fast: { model: 'haiku', defaultTimeout: 60000, effort: 'low' },
  standard: { model: 'sonnet', defaultTimeout: 240000, effort: 'medium' },
  smart: { model: 'opus', defaultTimeout: 240000, effort: 'high' },
  kimi: { model: KIMI_K3_MODEL, defaultTimeout: 240000 },
};

/**
 * Get level configurations (with optional USER/SYSTEM overrides)
 *
 * Allows customization via:
 * - USER:   ~/.claude/USER/config/inference.json
 * - SYSTEM: ~/.claude/docs/system/config/inference.json
 * - ENV:    KAYA_INFERENCE_FAST_MODEL, KAYA_INFERENCE_FAST_TIMEOUT, etc.
 */
function getLevelConfig(): Record<InferenceLevel, { model: string; defaultTimeout: number; effort?: string }> {
  try {
    return loadTieredConfig('inference', LevelConfigSchema, DEFAULT_LEVEL_CONFIG, {
      envPrefix: 'KAYA_INFERENCE',
    });
  } catch {
    // If config loading fails, use defaults
    return DEFAULT_LEVEL_CONFIG;
  }
}

// ============================================================================
// TOON ENCODING HELPERS (Phase 3a)
// ============================================================================

interface JsonArrayMatch {
  /** The original JSON string that was matched */
  original: string;
  /** The parsed array */
  parsed: unknown[];
  /** Start index in the source text */
  startIndex: number;
  /** End index in the source text */
  endIndex: number;
}

/**
 * Detect JSON arrays embedded in text.
 * Scans for [...] patterns, attempts JSON.parse, and returns matches
 * that are valid arrays of objects (suitable for TOON encoding).
 *
 * @param text - The text to scan for JSON arrays
 * @returns Array of matched JSON arrays with their positions
 */
export function detectJsonArraysInText(text: string): JsonArrayMatch[] {
  const matches: JsonArrayMatch[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const openIdx = text.indexOf('[', searchFrom);
    if (openIdx === -1) break;

    // Find the matching close bracket using a bracket depth counter
    let depth = 0;
    let inString = false;
    let escape = false;
    let closeIdx = -1;

    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }

    if (closeIdx === -1) {
      searchFrom = openIdx + 1;
      continue;
    }

    const candidate = text.slice(openIdx, closeIdx + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        matches.push({
          original: candidate,
          parsed,
          startIndex: openIdx,
          endIndex: closeIdx + 1,
        });
        searchFrom = closeIdx + 1;
      } else {
        searchFrom = openIdx + 1;
      }
    } catch {
      searchFrom = openIdx + 1;
    }
  }

  return matches;
}

/**
 * Replace JSON arrays in a prompt with TOON-encoded versions when savings are significant.
 * Uses lazy import of ToonHelper to avoid circular dependencies.
 *
 * @param text - The prompt text potentially containing JSON arrays
 * @returns The text with JSON arrays replaced by TOON format where savings justify it
 */
export function toonEncodePrompt(text: string): string {
  const matches = detectJsonArraysInText(text);
  if (matches.length === 0) return text;

  // Lazy import ToonHelper
  const { maybeEncode } = require("./ToonHelper") as typeof import("./ToonHelper");

  // Process matches in reverse order to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const encoded = maybeEncode(match.parsed);
    if (encoded.format === 'toon') {
      result = result.slice(0, match.startIndex) +
        `<toon-data>\n${encoded.data}\n</toon-data>` +
        result.slice(match.endIndex);
    }
  }

  return result;
}

/**
 * Check if TOON inference encoding is enabled in settings.json
 */
function isToonInferenceEnabled(): boolean {
  try {
    const { loadSettings } = require("./ConfigLoader") as typeof import("./ConfigLoader");
    const settings = loadSettings() as Record<string, unknown>;
    const toon = settings.toon as Record<string, boolean> | undefined;
    return toon?.enableInInference === true;
  } catch {
    return false;
  }
}

/**
 * Escape raw control characters (newlines, tabs, CR, etc.) that appear INSIDE
 * JSON string literals. LLMs frequently write multi-line string field values
 * (e.g. "telegram"/"voice"/"markdown"-style prose fields) using actual line
 * breaks rather than the `\n` escape sequence — which is invalid JSON and
 * makes JSON.parse throw "Bad control character in string literal" (root
 * cause of the 2026-05-30 Daily Briefing editorial fallback).
 *
 * Walks the string tracking in-string / escaped state so we only touch control
 * chars between quotes; structural whitespace outside strings is left intact.
 */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * Extract JSON from LLM output using 3 strategies:
 * 1. Direct parse (clean JSON response)
 * 2. Strip markdown code fences (most common LLM pattern)
 * 3. Greedy regex (find first JSON object or array)
 *
 * At each tier, a raw JSON.parse is tried first; if it throws, the SAME
 * candidate string is retried through escapeControlCharsInStrings() before
 * falling through to the next strategy. This repairs LLM responses that
 * contain raw literal newlines/tabs/control chars inside JSON string values
 * (invalid JSON) without touching already-valid JSON — the escaped variant is
 * only attempted after the raw parse fails.
 */
export function extractJson(output: string): unknown | undefined {
  const trimmed = output.trim();

  // Strategy 1: Direct parse (clean JSON response)
  try { return JSON.parse(trimmed); } catch { /* intentionally silent: falls through to escaped-string retry below */ }
  try { return JSON.parse(escapeControlCharsInStrings(trimmed)); } catch { /* intentionally silent: falls through to strategy 2 */ }

  // Strategy 2: Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    try { return JSON.parse(fenced); } catch { /* intentionally silent: falls through to escaped-string retry below */ }
    try { return JSON.parse(escapeControlCharsInStrings(fenced)); } catch { /* intentionally silent: falls through to strategy 3 */ }
  }

  // Strategy 3: Greedy regex (try both object and array patterns)
  for (const pattern of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
    const jsonMatch = trimmed.match(pattern);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch { /* intentionally silent: falls through to escaped-string retry below */ }
      try { return JSON.parse(escapeControlCharsInStrings(jsonMatch[0])); } catch { /* intentionally silent: tries the next pattern, or returns undefined */ }
    }
  }

  return undefined;
}

/** Outcome of parsing a `claude -p --output-format json` result envelope. */
export interface StructuredEnvelopeResult {
  ok: boolean;
  /** The schema-validated object from the envelope's `structured_output` field (when ok). */
  structuredOutput?: unknown;
  /** The envelope's `result` text (the model's prose reply), when present. */
  resultText: string;
  /** Real token usage reported by the envelope (all input categories summed), when present. */
  usage?: { input: number; output: number };
  error?: string;
}

/**
 * Parse the single-JSON-object envelope that `claude -p --output-format json`
 * writes to stdout, and extract the schema-validated `structured_output` field.
 *
 * Unlike extractJson() this input is NOT free-form LLM prose — it is a
 * machine-written envelope from the claude binary itself, so a strict
 * JSON.parse is correct and every deviation is a loud failure:
 *   - unparseable stdout → ok:false (binary contract changed / crashed mid-write)
 *   - is_error / non-"success" subtype → ok:false with the envelope's own message
 *   - missing structured_output → ok:false (the model was not schema-constrained)
 */
export function parseStructuredEnvelope(stdout: string): StructuredEnvelopeResult {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, resultText: '', error: 'schema path: envelope is valid JSON but not an object' };
    }
    envelope = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      resultText: '',
      error: `schema path: claude --output-format json envelope is not valid JSON (${(e as Error).message}); stdout starts: ${stdout.trim().slice(0, 200)}`,
    };
  }

  const resultText = typeof envelope.result === 'string' ? envelope.result : '';

  const usageRaw = envelope.usage as Record<string, unknown> | undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage = usageRaw && typeof usageRaw === 'object'
    ? {
        input: num(usageRaw.input_tokens) + num(usageRaw.cache_creation_input_tokens) + num(usageRaw.cache_read_input_tokens),
        output: num(usageRaw.output_tokens),
      }
    : undefined;

  if (envelope.is_error === true || (typeof envelope.subtype === 'string' && envelope.subtype !== 'success')) {
    return {
      ok: false,
      resultText,
      usage,
      error: `schema path: claude reported an error envelope (subtype: ${String(envelope.subtype)})${resultText ? `: ${resultText.slice(0, 300)}` : ''}`,
    };
  }

  if (envelope.structured_output === undefined) {
    return {
      ok: false,
      resultText,
      usage,
      error: 'schema path: envelope has no structured_output field — the model was not schema-constrained (check --json-schema support on the installed claude binary)',
    };
  }

  return { ok: true, structuredOutput: envelope.structured_output, resultText, usage };
}

/** Read a file's contents, returning empty string if missing or unreadable. */
function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Strip the keys that must never survive into a nested `claude -p` spawn:
 * ANTHROPIC_API_KEY (forces subscription auth) and all nesting-detection vars
 * (CLAUDE_CODE_* minus the allowlist: OAuth token + subscription type).
 * Mutates `env` in place.
 *
 * Exported (not just inlined in buildHardenedClaudeEnv) so any caller that
 * merges additional env on top of buildHardenedClaudeEnv()'s base — e.g.
 * AgentSpawner.ts, which merges a caller-supplied `opts.env` over the
 * hardened base — can re-apply the SAME denylist afterward instead of
 * duplicating it. A caller passing `env: {...process.env}` must not be able
 * to reintroduce these keys and un-harden the spawn.
 */
const HARDENED_CLAUDE_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
]);

export function stripDangerousClaudeEnvKeys(env: Record<string, string | undefined>): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') && !HARDENED_CLAUDE_ENV_ALLOWLIST.has(key)) {
      delete env[key];
    }
  }
}

/**
 * Build a hardened environment for spawning a nested `claude -p` subprocess.
 * Strips ANTHROPIC_API_KEY (forces subscription auth) and all nesting-detection
 * vars (CLAUDECODE, CLAUDE_CODE_* minus the allowlist), and injects
 * CLAUDE_CODE_OAUTH_TOKEN from secrets.json — PREFERRING it over any inherited
 * env value. process.env is frozen at process start, so a long-running server
 * (launchd board/dashboards) that inherited a token keeps spawning with it
 * after a rotation revokes it — every claude -p then fails with "401 OAuth
 * access token has been revoked" (2026-07-16 lucidtasks-board incident).
 * loadOAuthToken() is mtime-invalidated so it tracks rotations; the inherited
 * env token is only the fallback when secrets.json lacks one.
 *
 * Also guarantees ~/.claude/bin is on PATH (prepended, preserving the rest of
 * the inherited PATH). launchd's minimal PATH omits it, which silently broke
 * every `kaya-cli` call made from inside a launchd-spawned `claude -p`
 * session — this is the highest-impact PATH fix since it covers ALL
 * claude -p spawns, not just launchd-triggered ones.
 */
export function buildHardenedClaudeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  stripDangerousClaudeEnvKeys(env);
  // secrets.json wins over an inherited env token (see docblock); the
  // inherited value survives only when secrets.json has no token.
  const token = loadOAuthToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

  // The inference-only setup-token lacks user:profile scope, so Claude Code's
  // client-side entitlement check gets no tier data and silently downgrades
  // Fable 5 → Sonnet. This undocumented var feeds the credential builder the
  // missing tier (anthropics/claude-code #70124, #79360; live-verified
  // 2026-07-20). Remove once setup tokens carry user:profile upstream.
  env.CLAUDE_CODE_SUBSCRIPTION_TYPE = 'max';

  // defaultKayaHome() (real ~/.claude, env-independent) — the kaya-cli binary
  // is installed at the real home, not wherever KAYA_HOME points (crons set
  // KAYA_HOME=repo-root); must NOT follow the override.
  const claudeBin = join(defaultKayaHome(), 'bin');
  const existingPath = env.PATH ?? '';
  const pathSegments = existingPath.split(':').filter(Boolean);
  if (!pathSegments.includes(claudeBin)) {
    env.PATH = existingPath ? `${claudeBin}:${existingPath}` : claudeBin;
  } else {
    env.PATH = existingPath;
  }

  return env;
}

/**
 * Run a single inference attempt (one `claude -p` subprocess). No retry.
 */
/**
 * The `kimi` level: one HTTPS call to Moonshot instead of a `claude -p` spawn.
 *
 * Returns the same InferenceResult contract as the Claude path so callers never
 * branch on level. Two honest differences:
 *   - token counts are the API's REAL usage numbers, not the 4-chars≈1-token
 *     heuristic, so estimatedCostUSD here is an actual charge, not an estimate;
 *   - a missing MOONSHOT_API_KEY fails loud rather than falling back to Claude.
 *
 * @param options   userPrompt must already be TOON-encoded by the caller.
 * @param model     resolved model id from level config.
 * @param timeout   ms before the request is aborted.
 * @param startTime caller's clock start, so latency covers TOON encoding too.
 */
async function kimiInferenceOnce(
  options: InferenceOptions,
  model: string,
  timeout: number,
  startTime: number,
): Promise<InferenceResult> {
  const level: InferenceLevel = 'kimi';
  const zeroCost: InferenceResult['estimatedTokens'] = { input: 0, output: 0, total: 0 };

  const res = await moonshotChat({
    systemPrompt: options.systemPrompt,
    userPrompt: options.userPrompt,
    model,
    timeoutMs: timeout,
  });

  const latencyMs = Date.now() - startTime;

  if (!res.success) {
    return {
      success: false,
      output: res.output,
      error: res.error,
      latencyMs,
      level,
      estimatedTokens: zeroCost,
      estimatedCostUSD: 0,
    };
  }

  const output = res.output.trim();

  // Prefer the API's reported usage; fall back to the length heuristic only if
  // the response omitted it (so cost is never silently reported as zero).
  const inputTokens = res.usage?.inputTokens || estimateTokens(options.systemPrompt + '\n' + options.userPrompt);
  const outputTokens = res.usage?.outputTokens || estimateTokens(output);
  const costFields = {
    estimatedTokens: {
      input: inputTokens,
      output: outputTokens,
      total: res.usage?.totalTokens || inputTokens + outputTokens,
    },
    estimatedCostUSD: estimateCostUSD({ inputTokens, outputTokens, modelName: model }),
  };

  if (options.expectJson) {
    const parsed = extractJson(output);
    if (parsed !== undefined) {
      return { success: true, output, parsed, latencyMs, level, ...costFields };
    }
    return {
      success: false,
      output,
      error: 'No JSON found in response',
      latencyMs,
      level,
      estimatedTokens: zeroCost,
      estimatedCostUSD: 0,
    };
  }

  return { success: true, output, latencyMs, level, ...costFields };
}

async function inferenceOnce(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || 'standard';
  const levelConfig = getLevelConfig();
  const config = levelConfig[level];
  const startTime = Date.now();
  const timeout = options.timeout || config.defaultTimeout;

  // Optionally TOON-encode JSON arrays in the user prompt (Phase 3a)
  let userPrompt = options.userPrompt;
  if (options.toonEncodeInput && isToonInferenceEnabled()) {
    userPrompt = toonEncodePrompt(userPrompt);
  }

  // The kimi level is not a `claude -p` spawn — hand off to the HTTPS client
  // before any of the subprocess machinery below (env hardening, fd redirection,
  // SIGTERM timeout) is set up, since none of it applies.
  if (isExternalApiLevel(level)) {
    // Explicit decision (2026-08-01): schema-constrained output rides the
    // claude binary's --json-schema flag, which the Moonshot HTTPS path does
    // not have. Fail loud rather than silently degrading to extractJson().
    if (options.schema) {
      return {
        success: false,
        output: '',
        error: `schema option is not supported on the '${level}' level (no claude -p spawn). Use fast/standard/smart, or drop the schema option.`,
        latencyMs: Date.now() - startTime,
        level,
        estimatedTokens: { input: 0, output: 0, total: 0 },
        estimatedCostUSD: 0,
      };
    }
    return kimiInferenceOnce({ ...options, userPrompt }, config.model, timeout, startTime);
  }

  const env = buildHardenedClaudeEnv();

  // Use -p flag with stdin for user prompt (avoids CLI flag parsing issues
  // when content starts with special characters like ---)
  const args = [
    '-p',
    '--model', config.model,
    ...(config.effort ? ['--effort', config.effort] : []),
    '--tools', '',  // Disable tools for faster response
    // schema mode needs the JSON result envelope to carry structured_output;
    // plain mode stays on text so 73 existing expectJson callers are untouched.
    '--output-format', options.schema ? 'json' : 'text',
    '--setting-sources', '',  // Disable hooks to prevent recursion
    '--system-prompt', options.systemPrompt,
  ];
  if (options.schema) {
    args.push('--json-schema', JSON.stringify(options.schema));
  }

  // Redirect claude's stdout/stderr to temp files via file descriptors.
  // The claude binary's IPC with the parent Claude Code process suppresses
  // pipe-based output capture. File-descriptor redirection avoids this.
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpOut = `/tmp/kaya-inf-${uid}.out`;
  const tmpErr = `/tmp/kaya-inf-${uid}.err`;
  const outFd = openSync(tmpOut, 'w');
  const errFd = openSync(tmpErr, 'w');

  return new Promise((resolve) => {
    const cleanup = () => {
      try { closeSync(outFd); } catch {}
      try { closeSync(errFd); } catch {}
      try { unlinkSync(tmpOut); } catch {}
      try { unlinkSync(tmpErr); } catch {}
    };

    const proc = spawn(CLAUDE_PATH, args, {
      env,
      stdio: ['pipe', outFd, errFd],
    });

    // Pipe user prompt via stdin to avoid CLI argument parsing issues
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    // Zero-cost sentinel for failure paths
    const zeroCost: InferenceResult['estimatedTokens'] = { input: 0, output: 0, total: 0 };

    /** Compute cost fields from input prompt and output text. */
    const computeCostFields = (inputText: string, outputText: string) => {
      const inputTokens  = estimateTokens(inputText);
      const outputTokens = estimateTokens(outputText);
      return {
        estimatedTokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
        estimatedCostUSD: estimateCostUSD({ inputTokens, outputTokens, modelName: config.model }),
      };
    };

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      // Force kill if SIGTERM doesn't work after 2s
      const killId = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
      proc.on('close', () => clearTimeout(killId));
      const stdout = readFileSafe(tmpOut);
      const stderr = readFileSafe(tmpErr);
      cleanup();
      resolve({
        success: false,
        output: stdout,
        error: `Timeout after ${timeout}ms${stderr ? ` (stderr: ${stderr.slice(0, 500)})` : ''}`,
        latencyMs: Date.now() - startTime,
        level,
        estimatedTokens: zeroCost,
        estimatedCostUSD: 0,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;
      const stdout = readFileSafe(tmpOut);
      const stderr = readFileSafe(tmpErr);
      cleanup();

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          latencyMs,
          level,
          estimatedTokens: zeroCost,
          estimatedCostUSD: 0,
        });
        return;
      }

      const output = stdout.trim();

      // Schema-constrained path: stdout is the --output-format json envelope,
      // parsed comes from its validated structured_output field. extractJson()
      // never runs here; any envelope deviation fails loud.
      if (options.schema) {
        const envelope = parseStructuredEnvelope(output);
        if (!envelope.ok) {
          resolve({
            success: false,
            output: envelope.resultText || output,
            error: envelope.error,
            latencyMs,
            level,
            estimatedTokens: zeroCost,
            estimatedCostUSD: 0,
          });
          return;
        }
        // Prefer the envelope's REAL usage numbers over the length heuristic.
        const costFields = envelope.usage
          ? {
              estimatedTokens: {
                input: envelope.usage.input,
                output: envelope.usage.output,
                total: envelope.usage.input + envelope.usage.output,
              },
              estimatedCostUSD: estimateCostUSD({
                inputTokens: envelope.usage.input,
                outputTokens: envelope.usage.output,
                modelName: config.model,
              }),
            }
          : computeCostFields(options.systemPrompt + '\n' + userPrompt, envelope.resultText);
        resolve({
          success: true,
          output: envelope.resultText,
          parsed: envelope.structuredOutput,
          latencyMs,
          level,
          ...costFields,
        });
        return;
      }

      // Parse JSON if requested
      if (options.expectJson) {
        const parsed = extractJson(output);
        const costFields = computeCostFields(options.systemPrompt + '\n' + userPrompt, output);
        if (parsed !== undefined) {
          resolve({ success: true, output, parsed, latencyMs, level, ...costFields });
        } else {
          resolve({ success: false, output, error: 'No JSON found in response', latencyMs, level, estimatedTokens: zeroCost, estimatedCostUSD: 0 });
        }
        return;
      }

      const costFields = computeCostFields(options.systemPrompt + '\n' + userPrompt, output);
      resolve({
        success: true,
        output,
        latencyMs,
        level,
        ...costFields,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      cleanup();
      resolve({
        success: false,
        output: '',
        error: err.message,
        latencyMs: Date.now() - startTime,
        level,
        estimatedTokens: zeroCost,
        estimatedCostUSD: 0,
      });
    });
  });
}

/**
 * Run inference with configurable level, retrying on failure.
 *
 * A failed attempt is usually a transient network stall — most often the
 * machine slept mid-call and the TCP connection died. Bumping the timeout
 * does not help (the socket stays dead); only a fresh subprocess recovers.
 * Each retry is a brand-new `claude -p` spawn. Opt-in via `options.retries`;
 * the default of 0 keeps existing callers byte-for-byte unchanged.
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const retryDelayMs = options.retryDelayMs ?? 4000;

  let result = await inferenceOnce(options);
  for (let attempt = 1; !result.success && attempt <= retries; attempt++) {
    console.error(
      `[inference] attempt ${attempt}/${retries + 1} failed ` +
      `(${(result.error ?? 'unknown').slice(0, 120)}); retrying in ${retryDelayMs}ms`,
    );
    await new Promise((r) => setTimeout(r, retryDelayMs));
    result = await inferenceOnce(options);
  }
  return result;
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let expectJson = false;
  let schema: Record<string, unknown> | undefined;
  let timeout: number | undefined;
  let level: InferenceLevel = 'standard';
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      expectJson = true;
    } else if (args[i] === '--schema' && args[i + 1]) {
      try {
        const parsed: unknown = JSON.parse(args[i + 1]);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('schema must be a JSON object');
        }
        schema = parsed as Record<string, unknown>;
      } catch (e) {
        console.error(`Invalid --schema (must be a JSON Schema object): ${(e as Error).message}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--level' && args[i + 1]) {
      const requestedLevel = args[i + 1].toLowerCase();
      if (['fast', 'standard', 'smart', 'kimi'].includes(requestedLevel)) {
        level = requestedLevel as InferenceLevel;
      } else {
        console.error(`Invalid level: ${args[i + 1]}. Use fast, standard, smart, or kimi.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  if (positionalArgs.length < 2) {
    console.error('Usage: bun Inference.ts [--level fast|standard|smart|kimi] [--json] [--schema <json-schema>] [--timeout <ms>] <system_prompt> <user_prompt>');
    process.exit(1);
  }

  const [systemPrompt, userPrompt] = positionalArgs;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level,
    expectJson,
    schema,
    timeout,
  });

  if (result.success) {
    if ((schema || expectJson) && result.parsed !== undefined) {
      console.log(JSON.stringify(result.parsed));
    } else {
      console.log(result.output);
    }
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
