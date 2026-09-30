#!/usr/bin/env bun
/**
 * MoonshotClient.ts — Minimal OpenAI-compatible client for Moonshot AI's Kimi K3.
 *
 * PURPOSE:
 * Backs the `kimi` level of Inference.ts. Kimi K3 is served at
 * https://api.moonshot.ai/v1 with an OpenAI-compatible /chat/completions
 * surface, so this is a plain HTTPS call — NOT a `claude -p` subprocess like
 * every other inference level.
 *
 * SCOPE (deliberate):
 * This is a one-shot prompt→text client. No tool calling, no filesystem, no
 * agentic loop. Kaya sub-agents are `claude -p` processes that inherit the
 * whole Claude Code tool harness; Kimi's API offers none of that, so wiring it
 * in as an *inference tier* is the honest shape. Anything agentic would be a
 * separate build.
 *
 * BILLING: Metered API key (unlike the Claude levels, which ride Jm's
 * subscription). Every call here costs money — $3.00/M input ($0.30/M cached),
 * $15.00/M output as of 2026-07-24.
 *
 * AUTH: `MOONSHOT_API_KEY` in ~/.claude/secrets.json. Absent key fails LOUD —
 * never a silent fallback to a Claude level, because a silent downgrade would
 * hide that the tier Jm asked for is not actually running.
 */

import { existsSync, readFileSync } from "fs";
import { kayaHomePath } from "./KayaHome.ts";

/** Moonshot's OpenAI-compatible base URL. */
export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

/** Model id served by Moonshot for Kimi K3 (API live 2026-07-16). */
export const KIMI_K3_MODEL = "kimi-k3";

/** Published Kimi K3 pricing, USD per million tokens (2026-07-24). */
export const KIMI_K3_PRICING = {
  inputPerMillion: 3.0,
  /** Cache-hit input rate; we cannot see cache status per call, so this is documentation. */
  cachedInputPerMillion: 0.3,
  outputPerMillion: 15.0,
} as const;

/**
 * `fetch` is injectable so tests never touch the network and never need a key.
 * Matches the global fetch signature.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface MoonshotRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Defaults to KIMI_K3_MODEL. */
  model?: string;
  /** Abort the request after this many ms. */
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface MoonshotUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MoonshotResponse {
  success: boolean;
  /** Assistant text on success, empty string on failure. */
  output: string;
  error?: string;
  /** Real counts reported by the API — present only on success. */
  usage?: MoonshotUsage;
}

/**
 * Read MOONSHOT_API_KEY from secrets.json.
 *
 * Resolved at CALL time (not module load) so a KAYA_HOME override or a
 * mid-process secrets.json write is picked up — the same discipline
 * NotificationService uses. Returns null when absent or malformed; callers
 * must fail loud rather than substitute another provider.
 */
export function loadMoonshotApiKey(): string | null {
  const secretsPath = kayaHomePath("secrets.json");
  try {
    if (!existsSync(secretsPath)) return null;
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
    const key = secrets.MOONSHOT_API_KEY;
    if (typeof key !== "string") return null;
    const trimmed = key.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Malformed secrets.json is indistinguishable from "no key" for our purpose,
    // and the caller's error message names the file either way.
    return null;
  }
}

/** Shape of the OpenAI-compatible response we depend on. */
interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  error?: { message?: unknown };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * One-shot chat completion against Kimi K3.
 *
 * Never throws — every failure path (missing key, HTTP error, malformed body,
 * timeout, network error) resolves to `{ success: false, error }` so the
 * Inference layer can map it onto InferenceResult uniformly.
 */
export async function moonshotChat(
  req: MoonshotRequest,
  deps: { fetchFn?: FetchLike; apiKey?: string | null } = {},
): Promise<MoonshotResponse> {
  // Trim here too, not just in loadMoonshotApiKey: an injected/env-sourced key
  // of pure whitespace is truthy and would otherwise send `Bearer    ` and come
  // back as an opaque 401 instead of the actionable message below.
  const resolved = deps.apiKey !== undefined ? deps.apiKey : loadMoonshotApiKey();
  const apiKey = typeof resolved === "string" ? resolved.trim() : resolved;
  if (!apiKey) {
    return {
      success: false,
      output: "",
      error:
        "MOONSHOT_API_KEY missing from secrets.json — the kimi level cannot run. " +
        "Fix: bun ~/.claude/bin/setup-moonshot-key.ts " +
        "(create a key at https://platform.kimi.ai/console/api-keys; K3 needs a $1 minimum top-up). " +
        "Refusing to silently fall back to a Claude level.",
    };
  }

  const fetchFn = (deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike));
  const model = req.model ?? KIMI_K3_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: req.userPrompt },
    ],
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

  // AbortController drives the timeout; unlike the spawn-based levels there is
  // no subprocess to SIGTERM.
  const controller = new AbortController();
  const timeoutId =
    req.timeoutMs !== undefined ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined;

  try {
    const res = await fetchFn(`${MOONSHOT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();

    if (!res.ok) {
      // Moonshot returns a JSON error envelope; surface its message when present
      // so the caller sees "invalid api key" rather than a bare 401.
      let detail = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw) as ChatCompletionShape;
        const msg = parsed.error?.message;
        if (typeof msg === "string" && msg.length > 0) detail = msg;
      } catch {
        // intentionally silent: a non-JSON error body (HTML gateway page, empty
        // 502) is an ordinary upstream failure mode, and `detail` already holds
        // the raw text we surface — breadcrumbing here would double-log it.
      }
      return { success: false, output: "", error: `Moonshot HTTP ${res.status}: ${detail}` };
    }

    let parsed: ChatCompletionShape;
    try {
      parsed = JSON.parse(raw) as ChatCompletionShape;
    } catch {
      return {
        success: false,
        output: "",
        error: `Moonshot returned non-JSON body: ${raw.slice(0, 200)}`,
      };
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return {
        success: false,
        output: "",
        error: "Moonshot response missing choices[0].message.content",
      };
    }

    const inputTokens = toFiniteNumber(parsed.usage?.prompt_tokens);
    const outputTokens = toFiniteNumber(parsed.usage?.completion_tokens);
    const reportedTotal = toFiniteNumber(parsed.usage?.total_tokens);

    return {
      success: true,
      output: content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    return {
      success: false,
      output: "",
      error: aborted ? `Timeout after ${req.timeoutMs}ms` : message,
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
