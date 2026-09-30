#!/usr/bin/env bun
/**
 * VoiceSystemPrompt.ts - Voice-optimized system prompt builder
 *
 * Builds a concise, natural system prompt for real-time voice conversations
 * by combining Kaya's personality (DAIDENTITY.md), user identity (settings.json),
 * and optional dynamic context from ContextManager.
 *
 * The prompt instructs the LLM to respond in short, spoken-word sentences
 * without markdown, emoji, or formatting artifacts.
 *
 * Usage:
 *   import { buildVoiceSystemPrompt, getMinimalContext } from "./VoiceSystemPrompt.ts";
 *
 * CLI:
 *   bun VoiceSystemPrompt.ts preview          # Show assembled prompt
 *   bun VoiceSystemPrompt.ts preview --context # Show with sample context
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { KAYA_HOME, getIdentity } from "./VoiceCommon.ts";
import { loadSettings } from "../../../../lib/core/ConfigLoader.ts";

// ============================================================================
// Types
// ============================================================================

interface VoiceIdentity {
  name: string;
  userName: string;
  timezone: string;
  personalityTraits: string;
}

interface VoiceSystemPromptOptions {
  /** Dynamic context snippet from ContextManager (optional) */
  contextSnippet?: string;
  /** Override identity (for testing) */
  identity?: Partial<VoiceIdentity>;
}

// ============================================================================
// Personality Extraction
// ============================================================================

const DAIDENTITY_PATH = join(KAYA_HOME, "USER/DAIDENTITY.md");

/** Cached personality string */
let _cachedPersonality: string | null = null;
let _cachedPersonalityLoadedAt = 0;
const PERSONALITY_CACHE_TTL_MS = 3600000; // 1 hour

/**
 * Extract personality traits from DAIDENTITY.md.
 * Parses the Personality & Behavior and Natural Voice sections.
 * Returns a concise string suitable for a voice system prompt.
 */
function extractPersonalityTraits(): string {
  const now = Date.now();
  if (_cachedPersonality && now - _cachedPersonalityLoadedAt < PERSONALITY_CACHE_TTL_MS) {
    return _cachedPersonality;
  }

  if (!existsSync(DAIDENTITY_PATH)) {
    const fallback = "You are warm, efficient, and proactive. You speak with quiet confidence and occasional dry humor.";
    _cachedPersonality = fallback;
    _cachedPersonalityLoadedAt = now;
    return fallback;
  }

  const content = readFileSync(DAIDENTITY_PATH, "utf-8");

  // Extract key personality bullet points
  const traits: string[] = [];

  // Parse "Personality & Behavior" section
  const personalityMatch = content.match(/## Personality & Behavior\s*\n([\s\S]*?)(?=\n---|\n##)/);
  if (personalityMatch) {
    const lines = personalityMatch[1].split("\n").filter((l) => l.startsWith("- **"));
    for (const line of lines) {
      // Extract "Direct but Gentle - Tell harsh truths..." style
      const match = line.match(/- \*\*(.+?)\*\*\s*-\s*(.+)/);
      if (match) {
        traits.push(`${match[1].trim()}: ${match[2].trim()}`);
      }
    }
  }

  // Parse "Natural Voice" characteristics
  const voiceMatch = content.match(/\*\*Voice Characteristics:\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n---|\n##)/);
  if (voiceMatch) {
    const lines = voiceMatch[1].split("\n").filter((l) => l.startsWith("- "));
    for (const line of lines) {
      traits.push(line.replace(/^- /, "").trim());
    }
  }

  // Parse relationship model
  const roleMatch = content.match(/\*\*Assistant:\*\*\s*"(.+?)"/);
  if (roleMatch) {
    traits.push(roleMatch[1]);
  }

  const result = traits.length > 0
    ? traits.join("\n")
    : "You are warm, efficient, and proactive. You speak with quiet confidence and occasional dry humor.";

  _cachedPersonality = result;
  _cachedPersonalityLoadedAt = now;
  return result;
}

// ============================================================================
// Identity Loading
// ============================================================================

/**
 * Load full voice identity from settings.json and DAIDENTITY.md.
 */
function loadVoiceIdentity(overrides?: Partial<VoiceIdentity>): VoiceIdentity {
  const { assistantName, userName } = getIdentity();

  let timezone = "America/Los_Angeles";
  try {
    const settings = loadSettings();
    timezone = (settings as Record<string, unknown> as { principal?: { timezone?: string } }).principal?.timezone ?? timezone;
  } catch {
    // Use default timezone
  }

  return {
    name: overrides?.name ?? assistantName,
    userName: overrides?.userName ?? userName,
    timezone: overrides?.timezone ?? timezone,
    personalityTraits: overrides?.personalityTraits ?? extractPersonalityTraits(),
  };
}

// ============================================================================
// System Prompt Builder
// ============================================================================

/**
 * Build a voice-optimized system prompt for real-time voice conversations.
 *
 * The prompt is designed to produce concise, natural spoken responses
 * without any markdown, emoji, or formatting artifacts.
 *
 * @param options - Optional context snippet and identity overrides
 * @returns Complete system prompt string (<1000 tokens)
 */
export function buildVoiceSystemPrompt(options?: VoiceSystemPromptOptions): string {
  const identity = loadVoiceIdentity(options?.identity);
  const contextSnippet = options?.contextSnippet;

  const parts: string[] = [
    `You are ${identity.name}, a personal AI assistant. You are having a real-time voice conversation with ${identity.userName}.`,
    "",
    identity.personalityTraits,
    "",
    "VOICE MODE RULES:",
    "- Respond in 1-3 natural sentences. This will be spoken aloud.",
    "- Do NOT use markdown, bullet points, numbered lists, headers, or emoji.",
    "- Do NOT use the SUMMARY/ANALYSIS/STORY format. Just speak naturally.",
    "- Be warm, concise, and direct. Match the energy of a spoken conversation.",
    "- If a topic needs detail, give a brief verbal summary and offer to elaborate.",
    `- Address ${identity.userName} by name occasionally but not every turn.`,
    `- ${identity.timezone} is ${identity.userName}'s timezone. Reference time naturally ("this afternoon", "tomorrow morning").`,
    "- Contractions are encouraged. Speak like a real person.",
    "- Never say \"Happy to help\" or \"Is there anything else?\" -- just respond naturally.",
  ];

  if (contextSnippet) {
    parts.push("", "CURRENT CONTEXT:", contextSnippet);
  }

  return parts.join("\n");
}

/**
 * Get minimal context for fallback scenarios (when ContextManager is slow or unavailable).
 * Returns a bare-minimum identity string.
 */
export function getMinimalContext(overrides?: Partial<VoiceIdentity>): string {
  const identity = loadVoiceIdentity(overrides);
  return `${identity.userName} is the user. Timezone: ${identity.timezone}.`;
}

/**
 * Invalidate the cached personality, forcing a reload on next call.
 * Useful when DAIDENTITY.md is updated.
 */
export function invalidatePersonalityCache(): void {
  _cachedPersonality = null;
  _cachedPersonalityLoadedAt = 0;
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "preview": {
      const includeContext = args.includes("--context");
      const contextSnippet = includeContext
        ? "- Active goal: Ship real-time voice conversation system\n- Today: Tuesday, working from home\n- Recent win: Completed Phase 3 integration"
        : undefined;

      const prompt = buildVoiceSystemPrompt({ contextSnippet });
      console.log("=== Voice System Prompt ===\n");
      console.log(prompt);
      console.log(`\n=== ${prompt.length} characters ===`);
      break;
    }

    case "minimal": {
      const minimal = getMinimalContext();
      console.log("=== Minimal Context ===\n");
      console.log(minimal);
      break;
    }

    case "--help":
    case "help":
    default: {
      console.log(`VoiceSystemPrompt - Voice-optimized system prompt builder

Commands:
  preview [--context]   Show assembled voice system prompt
  minimal               Show minimal fallback context
  --help                Show this help`);
      break;
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { extractPersonalityTraits, loadVoiceIdentity };
export type { VoiceIdentity, VoiceSystemPromptOptions };
