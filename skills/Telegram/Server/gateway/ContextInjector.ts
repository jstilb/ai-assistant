/**
 * ContextInjector.ts - ContextManager bridge for mobile gateway
 *
 * Bridges the existing ContextManager skill to the mobile gateway pipeline:
 * 1. Classifies message intent using IntentClassifier
 * 2. Loads profile-specific context via ContextSelector
 * 3. Builds a system prompt with personality (DAIDENTITY), calendar, memory
 * 4. Respects token budgets for mobile efficiency
 *
 * The mobile system prompt is shorter than desktop but preserves
 * all Kaya personality and context awareness.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { classifyIntent } from "../../../ContextManager/Tools/IntentClassifier";
import type { ClassificationResult } from "../../../ContextManager/Tools/IntentClassifier";
import type {
  ContextPayload,
  MobileMessage,
  Session,
} from "./KayaMobileGateway";
import { formatSessionContext } from "./SessionManager";
import type { TelegramSettings } from "../../Tools/TelegramConfig";

const KAYA_HOME = process.env.HOME + "/.claude";

// Mobile-specific token budget (smaller than desktop)
const MOBILE_TOKEN_BUDGET = 4000;

// Files that should always be loaded for Kaya personality
const PERSONALITY_FILES = [
  "USER/DAIDENTITY.md",
];

// Profile-specific context files (lightweight versions for mobile)
const PROFILE_CONTEXT_MAP: Record<string, string[]> = {
  development: [
    "skills/CORE/CoreStack.md",
  ],
  "task-management": [
    "skills/LucidTasks/SKILL.md",
  ],
  scheduling: [
    "USER/CALENDAR-CONTEXT.md",
  ],
  "life-coaching": [
    "USER/TELOS.md",
  ],
  general: [],
  conversational: [],
};

/**
 * Read a context file safely, returning empty string on failure
 */
function readContextFile(relativePath: string): string {
  const absolutePath = join(KAYA_HOME, relativePath);
  if (!existsSync(absolutePath)) return "";

  try {
    const content = readFileSync(absolutePath, "utf-8");
    // Truncate large files for mobile
    if (content.length > 2000) {
      return content.substring(0, 2000) + "\n...(truncated for mobile)";
    }
    return content;
  } catch {
    return "";
  }
}

/**
 * Build the mobile system prompt with Kaya personality and context
 */
function buildMobileSystemPrompt(
  settings: TelegramSettings,
  profile: string,
  sessionContext: string,
  profileContext: string,
  timezone: string
): string {
  const aiName = settings.daidentity?.name || "Kaya";
  const userName = settings.principal?.name || "the user";

  // Load personality
  const personality = readContextFile("USER/DAIDENTITY.md");

  let prompt = `You are ${aiName}, a personal AI assistant communicating via Telegram mobile.

## Identity & Personality
${personality || `You are ${aiName}, warm, efficient, and knowledgeable.`}

## Communication Rules
- You are talking to ${userName} via mobile Telegram
- Keep responses concise and mobile-friendly (under 500 chars when possible)
- Use Markdown formatting sparingly (Telegram supports basic markdown)
- Be helpful, warm, and efficient
- Always end with a voice line: a single line prefixed with a speaking emoji that summarizes in 16 words max
- Format: (speaking emoji) ${aiName}: [16 words max factual summary]

## Context
Current time: ${new Date().toLocaleString("en-US", { timeZone: timezone })}
Profile: ${profile}`;

  // Add profile-specific context
  if (profileContext.trim()) {
    prompt += `\n\n## Domain Context\n${profileContext}`;
  }

  // Add session/conversation context
  if (sessionContext.trim()) {
    prompt += `\n\n## Conversation History\n${sessionContext}`;
  }

  prompt += `\n\nRespond naturally and helpfully to ${userName}'s message.`;

  return prompt;
}

/**
 * Inject context into the mobile message pipeline.
 *
 * Flow:
 * 1. Classify intent with IntentClassifier (keyword-first, inference fallback)
 * 2. Load profile-specific context files
 * 3. Format session context (summary + recent messages)
 * 4. Build complete system prompt
 */
export async function injectContext(
  message: MobileMessage,
  session: Session,
  settings: TelegramSettings,
  timezone: string
): Promise<ContextPayload> {
  // Step 1: Classify intent
  let classification: ClassificationResult;
  try {
    classification = await classifyIntent(
      message.text,
      session.exchangeCount > 0
    );
  } catch (error) {
    console.error("[ContextInjector] Classification failed:", error);
    classification = {
      profile: "general",
      confidence: 0.3,
      stage: "keyword",
      timestamp: new Date().toISOString(),
    };
  }

  const profile = classification.profile;

  // Step 2: Load profile-specific context
  const contextFiles = PROFILE_CONTEXT_MAP[profile] ?? [];
  const profileContext = contextFiles
    .map((file) => {
      const content = readContextFile(file);
      return content ? `### ${file}\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  // Step 3: Format session context
  const sessionContext = formatSessionContext(session);

  // Step 4: Build system prompt
  const systemPrompt = buildMobileSystemPrompt(
    settings,
    profile,
    sessionContext,
    profileContext,
    timezone
  );

  // Rough token estimate (4 chars ~ 1 token)
  const estimatedTokens = Math.ceil(systemPrompt.length / 4);

  return {
    systemPrompt,
    profile,
    confidence: classification.confidence,
    tokenBudget: MOBILE_TOKEN_BUDGET,
  };
}

/**
 * Simple context injection without ContextManager (fallback path).
 * Used when ContextManager is unavailable or for very simple messages.
 */
export function injectSimpleContext(
  session: Session,
  settings: TelegramSettings,
  timezone: string
): ContextPayload {
  const sessionContext = formatSessionContext(session);

  const systemPrompt = buildMobileSystemPrompt(
    settings,
    "general",
    sessionContext,
    "",
    timezone
  );

  return {
    systemPrompt,
    profile: "general",
    confidence: 1.0,
    tokenBudget: MOBILE_TOKEN_BUDGET,
  };
}
