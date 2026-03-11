#!/usr/bin/env bun
/**
 * outreach.ts - Email Draft Orchestration Script
 *
 * Generates personalized outreach emails using Inference (standard level),
 * creates Gmail drafts via kaya-cli, and updates pipeline state.
 *
 * Reads contact data from OutreachState, tone guidelines from EmailTemplates.md,
 * and uses Inference to generate the email body and subject line.
 *
 * CRITICAL: Never auto-sends. Always creates Gmail DRAFTS for Jm's review.
 *
 * Usage:
 *   bun outreach.ts --id <uuid>
 *   bun outreach.ts --id <uuid> --tone professional
 *   bun outreach.ts --id <uuid> --ask "grab coffee next week"
 *   bun outreach.ts --test
 *
 * @module outreach
 * @version 1.0.0
 */

import { spawn } from "child_process";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// ============================================
// TYPES
// ============================================

interface ContactRecord {
  id: string;
  name: string;
  email?: string;
  source: string;
  community: string;
  relevanceScore: number;
  connectionPoints: string[];
  stage: string;
  notes: string;
  profileUrl?: string;
  tags: string[];
  outreachDraftId?: string;
}

interface GeneratedEmail {
  subject: string;
  body: string;
  wordCount: number;
}

interface OutreachResult {
  success: boolean;
  contactId: string;
  contactName: string;
  email?: string;
  subject?: string;
  body?: string;
  wordCount?: number;
  tone?: string;
  draftId?: string;
  error?: string;
  rateStatus?: { sent: number; remaining: number };
}

type ToneProfile = "casual-friendly" | "professional" | "community-peer";

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = process.env.HOME + "/.claude";
const TOOLS_DIR = join(KAYA_HOME, "skills/Communication/CommunityOutreach/Tools");
const OUTREACH_STATE = join(TOOLS_DIR, "OutreachState.ts");
const INFERENCE_TOOL = join(KAYA_HOME, "lib/core/Inference.ts");
const EMAIL_TEMPLATES = join(KAYA_HOME, "skills/Communication/CommunityOutreach/EmailTemplates.md");
const KAYA_CLI = join(KAYA_HOME, "bin/kaya-cli");

// Community to default tone mapping
const COMMUNITY_TONE_MAP: Record<string, ToneProfile> = {
  "professional-ai": "professional",
  "writing-sd": "community-peer",
  "volleyball-sd": "casual-friendly",
  "surf-sd": "casual-friendly",
  "music-sd": "casual-friendly",
  "dsa-sd": "community-peer",
};

// Jm context snippets keyed by community relevance
const JM_CONTEXT_SNIPPETS: Record<string, string[]> = {
  "professional-ai": [
    "I'm building AI tools (personal AI infrastructure)",
    "I work in AI security, building Lucidview",
  ],
  "writing-sd": [
    "I'm working on a novel set in the film industry",
    "I write fiction -- short stories and a novel in progress",
  ],
  "volleyball-sd": [
    "I play beach volleyball in SD",
    "I recently moved to San Diego",
  ],
  "surf-sd": [
    "I'm learning to surf",
    "I recently moved to San Diego",
  ],
  "music-sd": [
    "I play piano and am looking for a music community",
    "I recently moved to San Diego",
  ],
  "dsa-sd": [
    "I recently moved to San Diego",
    "I'm getting more involved in community organizing",
  ],
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Run a CLI tool and return stdout
 */
function runTool(command: string, args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [command, ...args], {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Tool exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Run a binary (not bun script) and return stdout
 */
function runBinary(command: string, args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Binary exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Get a contact from the pipeline
 */
async function getContact(id: string): Promise<ContactRecord> {
  const output = await runTool(OUTREACH_STATE, ["get", "--id", id]);
  return JSON.parse(output);
}

/**
 * Check weekly outreach rate limit
 */
async function checkRateLimit(): Promise<{ allowed: boolean; sent: number; remaining: number }> {
  const output = await runTool(OUTREACH_STATE, ["rate-check"]);
  return JSON.parse(output);
}

/**
 * Load email templates file content
 */
function loadEmailTemplates(): string {
  if (!existsSync(EMAIL_TEMPLATES)) {
    return ""; // Graceful degradation
  }
  return readFileSync(EMAIL_TEMPLATES, "utf-8");
}

/**
 * Determine the tone for this contact
 */
function selectTone(contact: ContactRecord, toneOverride?: string): ToneProfile {
  if (toneOverride && ["casual-friendly", "professional", "community-peer"].includes(toneOverride)) {
    return toneOverride as ToneProfile;
  }
  return COMMUNITY_TONE_MAP[contact.community] || "community-peer";
}

/**
 * Get Jm context snippets relevant to this contact's community
 */
function getRelevantContext(community: string): string {
  const snippets = JM_CONTEXT_SNIPPETS[community] || JM_CONTEXT_SNIPPETS["professional-ai"];
  return snippets.join("\n- ");
}

/**
 * Generate a personalized email using Inference
 */
async function generateEmail(
  contact: ContactRecord,
  tone: ToneProfile,
  ask?: string
): Promise<GeneratedEmail> {
  const templates = loadEmailTemplates();

  const systemPrompt = `You are a personal email assistant helping write authentic, personalized outreach emails.

CRITICAL RULES:
- Under 150 words total
- One specific, low-friction ask (coffee, virtual chat, attend same event)
- Reference something specific about the recipient (their recent work, talk, project)
- Peer-to-peer tone, never fan-to-creator
- Include one brief line about who Jm is (relevant to this recipient)
- No corporate language, no buzzwords, no "picking your brain"
- Subject line must be specific and personal, not generic
- Sign off as "Jm"

TONE: ${tone}
- casual-friendly: Relaxed, like messaging someone you met at an event
- professional: Direct, substance-focused, peer-level
- community-peer: Fellow member interested in the community

ANTI-PATTERNS (never use):
- "I'm a huge fan of your work"
- "I'd love to pick your brain"
- "I know you're busy, but..."
- "I have an amazing opportunity"
- "Hope this email finds you well"
- Multiple paragraphs about Jm

${templates ? "EMAIL TEMPLATE GUIDELINES:\n" + templates.substring(0, 2000) : ""}

Return ONLY a JSON object with: {"subject": "...", "body": "...", "wordCount": number}`;

  const connectionPointsStr = contact.connectionPoints.length > 0
    ? contact.connectionPoints.join(", ")
    : "Same community";

  const userPrompt = `Write an outreach email from Jm to ${contact.name}.

RECIPIENT INFO:
- Name: ${contact.name}
- Community: ${contact.community}
- Background: ${contact.notes || "No additional info"}
- Connection Points: ${connectionPointsStr}
- Source: ${contact.source}
${contact.profileUrl ? `- Profile: ${contact.profileUrl}` : ""}

JM CONTEXT (use the most relevant 1-2):
- ${getRelevantContext(contact.community)}

SPECIFIC ASK: ${ask || "coffee or a virtual chat"}

Return ONLY the JSON object with subject, body, and wordCount.`;

  const output = await runTool(INFERENCE_TOOL, [
    "--level", "standard",
    "--json",
    systemPrompt,
    userPrompt,
  ], 45000);

  const parsed = JSON.parse(output);

  // Validate required fields
  if (!parsed.subject || !parsed.body) {
    throw new Error("Generated email missing subject or body");
  }

  // Count words if not provided
  const wordCount = parsed.wordCount || parsed.body.split(/\s+/).length;

  return {
    subject: parsed.subject,
    body: parsed.body,
    wordCount,
  };
}

/**
 * Validate generated email quality
 */
function validateEmail(email: GeneratedEmail): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (email.wordCount > 150) {
    issues.push(`Over 150 words (${email.wordCount})`);
  }

  if (!email.subject || email.subject.length < 5) {
    issues.push("Subject line too short or missing");
  }

  // Check for anti-patterns
  const antiPatterns = [
    "huge fan",
    "pick your brain",
    "I know you're busy",
    "amazing opportunity",
    "hope this email finds you",
  ];

  const bodyLower = email.body.toLowerCase();
  for (const pattern of antiPatterns) {
    if (bodyLower.includes(pattern)) {
      issues.push(`Anti-pattern detected: "${pattern}"`);
    }
  }

  // Check subject for generic patterns
  const genericSubjects = [
    "networking opportunity",
    "quick question",
    "can i pick your brain",
    "introduction",
    "partnership",
  ];

  const subjectLower = email.subject.toLowerCase();
  for (const generic of genericSubjects) {
    if (subjectLower.includes(generic)) {
      issues.push(`Generic subject line: "${email.subject}"`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Create a Gmail draft via kaya-cli
 */
async function createGmailDraft(
  to: string,
  subject: string,
  body: string
): Promise<string> {
  const args = [
    "gmail", "drafts", "create",
    "--to", to,
    "--subject", subject,
    "--body", body,
    "--json",
  ];

  const output = await runBinary(Kaya_CLI, args, 30000);

  // Try to extract draft ID from JSON output
  try {
    const parsed = JSON.parse(output);
    return parsed.id || parsed.draftId || parsed.draft?.id || "draft-created";
  } catch {
    // If not JSON, try to extract an ID from the text
    const match = output.match(/[a-zA-Z0-9_-]{10,}/);
    return match ? match[0] : "draft-created";
  }
}

/**
 * Update pipeline state after drafting
 */
async function updatePipelineAfterDraft(
  contactId: string,
  draftId: string,
  tone: string
): Promise<void> {
  const now = new Date().toISOString().split("T")[0];
  const args = [
    "update",
    "--id", contactId,
    "--stage", "drafted",
    "--draft-id", draftId,
    "--notes", `Draft created on ${now}, tone: ${tone}`,
  ];

  await runTool(OUTREACH_STATE, args);
}

// ============================================
// MAIN ORCHESTRATION
// ============================================

async function outreach(
  contactId: string,
  toneOverride?: string,
  ask?: string
): Promise<OutreachResult> {
  // Step 1: Load contact
  let contact: ContactRecord;
  try {
    contact = await getContact(contactId);
  } catch (err) {
    return {
      success: false,
      contactId,
      contactName: "unknown",
      error: `Contact not found: ${err instanceof Error ? err.message : err}`,
    };
  }

  console.error(`[outreach] Generating email for: ${contact.name} (${contact.community})`);

  // Step 2: Precondition checks
  if (contact.stage === "opted-out") {
    return {
      success: false,
      contactId,
      contactName: contact.name,
      error: "Contact has opted out. Outreach is not permitted.",
    };
  }

  if (!contact.email) {
    return {
      success: false,
      contactId,
      contactName: contact.name,
      error: "No email address on file. Run enrich.ts first or manually add an email address.",
    };
  }

  // Step 3: Rate limit check
  let rateStatus: { allowed: boolean; sent: number; remaining: number };
  try {
    rateStatus = await checkRateLimit();
  } catch {
    rateStatus = { allowed: true, sent: 0, remaining: 10 };
    console.error("[outreach] Rate check failed, proceeding with assumed capacity");
  }

  if (!rateStatus.allowed) {
    return {
      success: false,
      contactId,
      contactName: contact.name,
      error: `Weekly outreach limit reached (${rateStatus.sent}/10). Wait for next week.`,
      rateStatus: { sent: rateStatus.sent, remaining: rateStatus.remaining },
    };
  }

  // Step 4: Select tone
  const tone = selectTone(contact, toneOverride);
  console.error(`[outreach] Tone: ${tone}`);

  // Step 5: Generate email
  let email: GeneratedEmail;
  try {
    email = await generateEmail(contact, tone, ask);
    console.error(`[outreach] Generated email: "${email.subject}" (${email.wordCount} words)`);
  } catch (err) {
    return {
      success: false,
      contactId,
      contactName: contact.name,
      error: `Email generation failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Step 6: Validate email quality
  const validation = validateEmail(email);
  if (!validation.valid) {
    console.error(`[outreach] Quality issues detected: ${validation.issues.join(", ")}`);
    // Still proceed but log warnings -- Jm will review the draft
  }

  // Step 7: Create Gmail draft
  let draftId: string;
  try {
    draftId = await createGmailDraft(contact.email, email.subject, email.body);
    console.error(`[outreach] Gmail draft created: ${draftId}`);
  } catch (err) {
    // If Gmail draft fails, still return the email text so Jm can use it
    console.error(`[outreach] Gmail draft creation failed: ${err instanceof Error ? err.message : err}`);
    return {
      success: false,
      contactId,
      contactName: contact.name,
      email: contact.email,
      subject: email.subject,
      body: email.body,
      wordCount: email.wordCount,
      tone,
      error: `Gmail draft creation failed: ${err instanceof Error ? err.message : err}. Email text included in output for manual use.`,
      rateStatus: { sent: rateStatus.sent, remaining: rateStatus.remaining },
    };
  }

  // Step 8: Update pipeline state
  try {
    await updatePipelineAfterDraft(contactId, draftId, tone);
  } catch (err) {
    console.error(`[outreach] Pipeline update failed (draft still created): ${err instanceof Error ? err.message : err}`);
  }

  return {
    success: true,
    contactId,
    contactName: contact.name,
    email: contact.email,
    subject: email.subject,
    body: email.body,
    wordCount: email.wordCount,
    tone,
    draftId,
    rateStatus: { sent: rateStatus.sent + 1, remaining: rateStatus.remaining - 1 },
  };
}

// ============================================
// SELF-TEST
// ============================================

async function runSelfTest(): Promise<void> {
  console.log("Running outreach.ts self-test...\n");

  let passed = 0;
  let failed = 0;

  const test = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  };

  // Test tool paths exist
  test("OutreachState.ts exists", () => {
    if (!existsSync(OUTREACH_STATE)) throw new Error(`Not found: ${OUTREACH_STATE}`);
  });

  test("Inference.ts exists", () => {
    if (!existsSync(INFERENCE_TOOL)) throw new Error(`Not found: ${INFERENCE_TOOL}`);
  });

  test("EmailTemplates.md exists", () => {
    if (!existsSync(EMAIL_TEMPLATES)) throw new Error(`Not found: ${EMAIL_TEMPLATES}`);
  });

  test("kaya-cli exists", () => {
    if (!existsSync(Kaya_CLI)) throw new Error(`Not found: ${KAYA_CLI}`);
  });

  // Test tone selection
  test("selectTone returns professional for professional-ai", () => {
    const contact = { community: "professional-ai" } as ContactRecord;
    const tone = selectTone(contact);
    if (tone !== "professional") throw new Error(`Expected professional, got ${tone}`);
  });

  test("selectTone returns casual-friendly for surf-sd", () => {
    const contact = { community: "surf-sd" } as ContactRecord;
    const tone = selectTone(contact);
    if (tone !== "casual-friendly") throw new Error(`Expected casual-friendly, got ${tone}`);
  });

  test("selectTone respects override", () => {
    const contact = { community: "professional-ai" } as ContactRecord;
    const tone = selectTone(contact, "casual-friendly");
    if (tone !== "casual-friendly") throw new Error(`Expected casual-friendly, got ${tone}`);
  });

  // Test email validation
  test("validateEmail catches word count over 150", () => {
    const email: GeneratedEmail = {
      subject: "Test subject",
      body: "word ".repeat(160),
      wordCount: 160,
    };
    const result = validateEmail(email);
    if (result.valid) throw new Error("Should have failed validation");
    if (!result.issues.some(i => i.includes("150 words"))) throw new Error("Should flag word count");
  });

  test("validateEmail catches anti-patterns", () => {
    const email: GeneratedEmail = {
      subject: "Test",
      body: "I'm a huge fan of your work and I'd love to pick your brain.",
      wordCount: 12,
    };
    const result = validateEmail(email);
    if (result.valid) throw new Error("Should have failed validation");
    if (!result.issues.some(i => i.includes("Anti-pattern"))) throw new Error("Should flag anti-pattern");
  });

  test("validateEmail passes clean email", () => {
    const email: GeneratedEmail = {
      subject: "Fellow SD AI builder -- your agent talk resonated",
      body: "Hi Alex, I saw your talk on agent architectures at the SD AI meetup. Your point about tool-use patterns resonated with what I'm building. I'm working on AI security tools in SD. Would you be up for coffee sometime next week? Jm",
      wordCount: 42,
    };
    const result = validateEmail(email);
    if (!result.valid) throw new Error(`Unexpected issues: ${result.issues.join(", ")}`);
  });

  test("validateEmail catches generic subject", () => {
    const email: GeneratedEmail = {
      subject: "Networking opportunity",
      body: "Hi, this is a test email. Jm",
      wordCount: 8,
    };
    const result = validateEmail(email);
    if (result.valid) throw new Error("Should have failed validation");
    if (!result.issues.some(i => i.includes("Generic subject"))) throw new Error("Should flag generic subject");
  });

  // Test context snippets
  test("getRelevantContext returns snippets for known communities", () => {
    const ctx = getRelevantContext("professional-ai");
    if (!ctx.includes("AI")) throw new Error("Should include AI context");
  });

  test("getRelevantContext falls back for unknown community", () => {
    const ctx = getRelevantContext("unknown-community");
    if (!ctx) throw new Error("Should return fallback context");
  });

  // Test email templates loading
  test("loadEmailTemplates returns non-empty content", () => {
    const content = loadEmailTemplates();
    if (!content || content.length === 0) throw new Error("Templates should not be empty");
    if (!content.includes("Under 150 words")) throw new Error("Should contain word limit guideline");
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================
// CLI INTERFACE
// ============================================

function printHelp(): void {
  console.log(`
outreach.ts - Email Draft Orchestration

Usage:
  bun outreach.ts --id <uuid> [--tone <tone>] [--ask "specific ask"]
  bun outreach.ts --test

Options:
  --id      Contact UUID (required) - must have email and be at "profiled" stage or later
  --tone    Override tone: casual-friendly, professional, community-peer
  --ask     Custom ask (default: "coffee or a virtual chat")
  --test    Run self-tests

Notes:
  - Contact must have an email address on file
  - Creates a Gmail DRAFT (never auto-sends)
  - Respects weekly outreach limit of 10
  - Falls back to showing email text if Gmail draft creation fails
  - Reviews EmailTemplates.md for tone guidelines and anti-patterns
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      parsed[args[i].replace("--", "")] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      parsed[args[i].replace("--", "")] = "true";
    }
  }
  return parsed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--test")) {
    await runSelfTest();
    process.exit(0);
  }

  const parsed = parseArgs(args);

  if (!parsed.id) {
    console.error("Error: --id is required");
    printHelp();
    process.exit(1);
  }

  try {
    const result = await outreach(parsed.id, parsed.tone, parsed.ask);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
