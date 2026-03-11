#!/usr/bin/env bun
/**
 * ProfileAnalyzer.ts - Relevance Scoring and Compatibility Analysis
 *
 * Scores contacts for relevance to Jm's goals and identifies specific
 * connection points. Uses Inference standard tier for analysis.
 *
 * Scoring Dimensions (0.0-1.0 each, weighted average):
 *   - Shared Interests (30%): Overlap in interests, projects, hobbies
 *   - Goal Alignment (30%): How well they align with Jm's TELOS goals
 *   - Community Overlap (20%): Membership in same target communities
 *   - Location (20%): Geographic proximity (SD = highest, SoCal = medium)
 *
 * Usage:
 *   bun ProfileAnalyzer.ts analyze --name "Person" --bio "Their bio text" --community "professional-ai"
 *   bun ProfileAnalyzer.ts analyze --json '{"name":"Person","bio":"Bio","interests":["AI","surfing"]}'
 *   bun ProfileAnalyzer.ts --test
 *
 * @module ProfileAnalyzer
 * @version 1.0.0
 */

import { spawn } from "child_process";
import { join } from "path";

// ============================================
// TYPES
// ============================================

export interface ProfileInput {
  name: string;
  bio?: string;
  interests?: string[];
  location?: string;
  community: string;
  occupation?: string;
  projects?: string[];
  socialProfiles?: string[];
  recentActivity?: string[];
}

export interface AnalysisResult {
  relevanceScore: number;
  connectionPoints: string[];
  flags: string[];
  whyConnect: string;
  suggestedTone: "casual-friendly" | "professional" | "community-peer";
  suggestedTags: string[];
  scores: {
    sharedInterests: number;
    goalAlignment: number;
    communityOverlap: number;
    location: number;
  };
}

// ============================================
// JM'S CONTEXT (for matching)
// ============================================

const JM_CONTEXT = {
  location: "San Diego, CA",
  interests: [
    "artificial intelligence",
    "machine learning",
    "AI agents",
    "security",
    "cybersecurity",
    "fiction writing",
    "novels",
    "short stories",
    "volleyball",
    "surfing",
    "piano",
    "music",
    "political organizing",
    "startups",
    "entrepreneurship",
  ],
  projects: [
    "Kaya (Personal AI Assistant)",
    "Lucidview (AI security tool)",
    "On Set (novel)",
  ],
  communities: [
    "professional-ai",
    "writing-sd",
    "volleyball-sd",
    "surf-sd",
    "music-sd",
    "dsa-sd",
  ],
  goals: {
    cofounder: "Looking for a cofounder for AI startup",
    community: "Building community connections in San Diego",
    writing: "Active fiction writer, working on novel and short stories",
    professional: "AI/security professional building tools",
  },
  locationTiers: {
    "san diego": 1.0,
    sd: 1.0,
    "southern california": 0.7,
    socal: 0.7,
    california: 0.4,
    ca: 0.4,
    remote: 0.2,
  },
};

// ============================================
// SCORING FUNCTIONS
// ============================================

/**
 * Score shared interests between the profile and Jm
 */
function scoreSharedInterests(profile: ProfileInput): {
  score: number;
  matches: string[];
} {
  const matches: string[] = [];

  const profileText = [
    profile.bio || "",
    ...(profile.interests || []),
    ...(profile.projects || []),
    profile.occupation || "",
    ...(profile.recentActivity || []),
  ]
    .join(" ")
    .toLowerCase();

  for (const interest of JM_CONTEXT.interests) {
    if (profileText.includes(interest.toLowerCase())) {
      matches.push(interest);
    }
  }

  // Check for project overlap
  for (const project of JM_CONTEXT.projects) {
    const projectKeywords = project.toLowerCase().split(/[\s()]+/);
    for (const keyword of projectKeywords) {
      if (keyword.length > 3 && profileText.includes(keyword)) {
        matches.push(`project overlap: ${project}`);
        break;
      }
    }
  }

  const score = Math.min(1.0, matches.length / 4); // 4+ matches = 1.0
  return { score, matches: [...new Set(matches)] };
}

/**
 * Score goal alignment
 */
function scoreGoalAlignment(profile: ProfileInput): {
  score: number;
  alignments: string[];
} {
  const alignments: string[] = [];
  let score = 0;

  const profileText = [
    profile.bio || "",
    ...(profile.interests || []),
    profile.occupation || "",
    ...(profile.projects || []),
  ]
    .join(" ")
    .toLowerCase();

  // Cofounder potential (G26) - highest value
  const cofounderkeywords = [
    "startup",
    "founder",
    "cofounder",
    "co-founder",
    "entrepreneur",
    "building",
    "ai startup",
    "side project",
  ];
  for (const kw of cofounderkeywords) {
    if (profileText.includes(kw)) {
      alignments.push("cofounder-potential (G26)");
      score += 0.35;
      break;
    }
  }

  // Professional community (G12)
  const professionalKeywords = [
    "ai",
    "machine learning",
    "security",
    "cybersecurity",
    "tech community",
    "meetup organizer",
  ];
  for (const kw of professionalKeywords) {
    if (profileText.includes(kw)) {
      alignments.push("professional-community (G12)");
      score += 0.25;
      break;
    }
  }

  // Writing community (G10)
  const writingKeywords = [
    "fiction",
    "novel",
    "writer",
    "author",
    "short story",
    "writing group",
    "literary",
  ];
  for (const kw of writingKeywords) {
    if (profileText.includes(kw)) {
      alignments.push("writing-community (G10)");
      score += 0.2;
      break;
    }
  }

  // Friend potential (G21)
  const friendKeywords = [
    "volleyball",
    "surf",
    "music",
    "piano",
    "creative",
    "community",
  ];
  for (const kw of friendKeywords) {
    if (profileText.includes(kw)) {
      alignments.push("friendship-potential (G21)");
      score += 0.15;
      break;
    }
  }

  return { score: Math.min(1.0, score), alignments };
}

/**
 * Score community overlap
 */
function scoreCommunityOverlap(profile: ProfileInput): {
  score: number;
  communities: string[];
} {
  const communities: string[] = [];

  if (JM_CONTEXT.communities.includes(profile.community)) {
    communities.push(profile.community);
  }

  // Check for cross-community signals
  const profileText = [profile.bio || "", ...(profile.interests || [])]
    .join(" ")
    .toLowerCase();

  const communitySignals: Record<string, string[]> = {
    "professional-ai": ["ai", "machine learning", "tech", "startup"],
    "writing-sd": ["writing", "fiction", "author", "novel"],
    "volleyball-sd": ["volleyball", "beach volleyball", "vball"],
    "surf-sd": ["surf", "surfing", "waves"],
    "music-sd": ["music", "piano", "guitar", "jam", "open mic"],
    "dsa-sd": ["dsa", "democratic socialists", "organizing"],
  };

  for (const [community, signals] of Object.entries(communitySignals)) {
    if (community === profile.community) continue;
    for (const signal of signals) {
      if (profileText.includes(signal)) {
        communities.push(community);
        break;
      }
    }
  }

  const score = Math.min(1.0, communities.length / 2); // 2+ communities = 1.0
  return { score, communities: [...new Set(communities)] };
}

/**
 * Score location proximity
 */
function scoreLocation(profile: ProfileInput): number {
  if (!profile.location) return 0.1; // Unknown location gets minimal score

  const loc = profile.location.toLowerCase();

  for (const [key, value] of Object.entries(JM_CONTEXT.locationTiers)) {
    if (loc.includes(key)) {
      return value;
    }
  }

  return 0.1; // Default for unknown locations
}

// ============================================
// MAIN ANALYZER
// ============================================

/**
 * Analyze a profile and return relevance scoring
 */
export function analyzeProfile(profile: ProfileInput): AnalysisResult {
  const interestResult = scoreSharedInterests(profile);
  const goalResult = scoreGoalAlignment(profile);
  const communityResult = scoreCommunityOverlap(profile);
  const locationScore = scoreLocation(profile);

  // Weighted average
  const relevanceScore = Math.round(
    (interestResult.score * 0.3 +
      goalResult.score * 0.3 +
      communityResult.score * 0.2 +
      locationScore * 0.2) *
      100
  ) / 100;

  // Build connection points
  const connectionPoints: string[] = [
    ...interestResult.matches.map((m) =>
      m.startsWith("project") ? m : `shared interest: ${m}`
    ),
    ...goalResult.alignments,
    ...communityResult.communities.map((c) => `community: ${c}`),
  ];

  // Determine flags
  const flags: string[] = [];
  if (goalResult.alignments.some((a) => a.includes("cofounder"))) {
    flags.push("cofounder-potential");
  }
  if (communityResult.communities.length >= 2) {
    flags.push("cross-community");
  }
  if (relevanceScore >= 0.7) {
    flags.push("high-value");
  }
  if (
    interestResult.matches.some(
      (m) =>
        m.includes("organizer") || m.includes("speaker") || m.includes("leader")
    )
  ) {
    flags.push("community-leader");
  }

  // Generate "why connect" summary
  const topPoints = connectionPoints.slice(0, 3);
  const whyConnect =
    topPoints.length > 0
      ? `${profile.name} is a strong connection opportunity: ${topPoints.join("; ")}. ` +
        `Relevance score: ${relevanceScore}.`
      : `${profile.name} is in the ${profile.community} community. Limited connection data available.`;

  // Suggest tone based on community and context
  let suggestedTone: "casual-friendly" | "professional" | "community-peer" =
    "community-peer";
  if (
    profile.community === "professional-ai" ||
    goalResult.alignments.some((a) => a.includes("cofounder"))
  ) {
    suggestedTone = "professional";
  } else if (
    ["surf-sd", "volleyball-sd", "music-sd"].includes(profile.community)
  ) {
    suggestedTone = "casual-friendly";
  }

  // Suggest tags
  const suggestedTags: string[] = [...flags];
  if (locationScore >= 0.7) suggestedTags.push("local-sd");
  suggestedTags.push(profile.community);

  return {
    relevanceScore,
    connectionPoints,
    flags,
    whyConnect,
    suggestedTone,
    suggestedTags: [...new Set(suggestedTags)],
    scores: {
      sharedInterests: interestResult.score,
      goalAlignment: goalResult.score,
      communityOverlap: communityResult.score,
      location: locationScore,
    },
  };
}

/**
 * Enhanced analysis using Inference tool for deeper insights
 * Falls back to local analysis if Inference is unavailable
 */
export async function analyzeProfileDeep(
  profile: ProfileInput
): Promise<AnalysisResult> {
  // Start with local analysis as baseline
  const localResult = analyzeProfile(profile);

  // Attempt to enhance with Inference
  try {
    const inferenceScript = join(
      process.env.HOME || "",
      ".claude/lib/core/Inference.ts"
    );

    const systemPrompt = `You are a networking analyst helping someone build authentic professional and personal connections. Analyze this profile for compatibility with the user's goals and interests.

User Context:
- Lives in San Diego
- Works in AI/security, building tools (Kaya, Lucidview)
- Writes fiction (novel "On Set")
- Active in volleyball, learning to surf, plays piano
- Looking for cofounder for AI startup
- Values authenticity and directness
- Active communities: AI/tech, writing, volleyball, surf, music, DSA`;

    const userPrompt = `Analyze this person's profile for connection potential:

Name: ${profile.name}
Bio: ${profile.bio || "N/A"}
Location: ${profile.location || "N/A"}
Community: ${profile.community}
Interests: ${(profile.interests || []).join(", ") || "N/A"}
Occupation: ${profile.occupation || "N/A"}
Projects: ${(profile.projects || []).join(", ") || "N/A"}
Recent Activity: ${(profile.recentActivity || []).join(", ") || "N/A"}

Return a JSON object with:
{
  "connectionPoints": ["specific shared interest or overlap 1", "..."],
  "whyConnect": "2-3 sentence summary of why this person is worth connecting with",
  "flags": ["cofounder-potential", "community-leader", "cross-community", "high-value"],
  "suggestedTone": "casual-friendly | professional | community-peer",
  "adjustedScore": 0.0-1.0
}

Only return the JSON, no other text.`;

    const proc = spawn("bun", [inferenceScript, "--level", "standard", "--json", systemPrompt, userPrompt], {
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`Inference failed: ${stderr}`));
      });
      proc.on("error", reject);
    });

    // Parse inference result and merge with local analysis
    const inferenceResult = JSON.parse(stdout.trim());

    if (inferenceResult.connectionPoints) {
      localResult.connectionPoints = [
        ...new Set([
          ...localResult.connectionPoints,
          ...inferenceResult.connectionPoints,
        ]),
      ];
    }
    if (inferenceResult.whyConnect) {
      localResult.whyConnect = inferenceResult.whyConnect;
    }
    if (inferenceResult.flags) {
      localResult.flags = [
        ...new Set([...localResult.flags, ...inferenceResult.flags]),
      ];
    }
    if (inferenceResult.suggestedTone) {
      localResult.suggestedTone = inferenceResult.suggestedTone;
    }
    if (inferenceResult.adjustedScore !== undefined) {
      // Average local and inference scores
      localResult.relevanceScore =
        Math.round(
          ((localResult.relevanceScore + inferenceResult.adjustedScore) / 2) *
            100
        ) / 100;
    }
  } catch {
    // Inference unavailable or failed -- use local result as-is
    console.error(
      "Note: Inference enhancement unavailable, using local analysis only."
    );
  }

  return localResult;
}

// ============================================
// CLI INTERFACE
// ============================================

function printHelp(): void {
  console.log(`
ProfileAnalyzer - Relevance Scoring and Compatibility Analysis

Usage:
  bun ProfileAnalyzer.ts analyze --name "Name" --community "community-id" [options]
  bun ProfileAnalyzer.ts analyze --json '{"name":"Name","bio":"Bio","community":"professional-ai"}'
  bun ProfileAnalyzer.ts deep --name "Name" --community "community-id" [options]
  bun ProfileAnalyzer.ts --test

Options:
  --name          Person's name (required)
  --community     Community ID (required)
  --bio           Biography text
  --location      Location
  --interests     Comma-separated interests
  --occupation    Occupation/role
  --projects      Comma-separated projects
  --json          Full JSON profile input

Modes:
  analyze    Local scoring only (fast, no API calls)
  deep       Enhanced with Inference tool (slower, more accurate)
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
    } else if (!parsed._command) {
      parsed._command = args[i];
    }
  }
  return parsed;
}

async function runSelfTest(): Promise<void> {
  console.log("Running ProfileAnalyzer self-test...\n");

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

  // Test high-relevance AI founder in SD
  test("High-relevance AI founder in SD scores > 0.5", () => {
    const result = analyzeProfile({
      name: "Alex Chen",
      bio: "AI startup founder building ML tools. Former Google engineer. San Diego based.",
      interests: ["artificial intelligence", "machine learning", "startups", "surfing"],
      location: "San Diego, CA",
      community: "professional-ai",
      occupation: "Startup Founder",
      projects: ["ML security platform"],
    });
    if (result.relevanceScore < 0.5) throw new Error(`Score too low: ${result.relevanceScore}`);
    if (!result.flags.includes("cofounder-potential")) throw new Error("Missing cofounder-potential flag");
    if (result.suggestedTone !== "professional") throw new Error(`Wrong tone: ${result.suggestedTone}`);
  });

  // Test low-relevance distant person
  test("Low-relevance distant person scores < 0.3", () => {
    const result = analyzeProfile({
      name: "Random Person",
      bio: "Accountant in New York. Enjoys cooking and gardening.",
      interests: ["cooking", "gardening"],
      location: "New York, NY",
      community: "professional-ai",
      occupation: "Accountant",
    });
    if (result.relevanceScore >= 0.3) throw new Error(`Score too high: ${result.relevanceScore}`);
  });

  // Test cross-community detection
  test("Cross-community person gets flagged", () => {
    const result = analyzeProfile({
      name: "Creative Tech Writer",
      bio: "Software engineer who writes fiction on the side. Plays guitar at open mics.",
      interests: ["ai", "fiction writing", "music", "guitar"],
      location: "San Diego",
      community: "writing-sd",
      occupation: "Software Engineer",
    });
    if (!result.flags.includes("cross-community")) throw new Error("Missing cross-community flag");
    if (result.connectionPoints.length < 2) throw new Error(`Too few connection points: ${result.connectionPoints.length}`);
  });

  // Test casual-friendly tone for sports community
  test("Surf community gets casual-friendly tone", () => {
    const result = analyzeProfile({
      name: "Beach Person",
      bio: "Surfer and beach volleyball player in Pacific Beach.",
      interests: ["surfing", "volleyball"],
      location: "San Diego",
      community: "surf-sd",
    });
    if (result.suggestedTone !== "casual-friendly") throw new Error(`Wrong tone: ${result.suggestedTone}`);
  });

  // Test connection points generation
  test("Connection points are generated correctly", () => {
    const result = analyzeProfile({
      name: "Tech Writer",
      bio: "Building AI tools and writing fiction",
      interests: ["artificial intelligence", "fiction writing"],
      location: "San Diego",
      community: "professional-ai",
    });
    if (result.connectionPoints.length === 0) throw new Error("No connection points generated");
    if (!result.whyConnect) throw new Error("Missing whyConnect summary");
  });

  // Test location scoring
  test("San Diego location scores 1.0", () => {
    const score = scoreLocation({ name: "Test", location: "San Diego, CA", community: "professional-ai" });
    if (score !== 1.0) throw new Error(`Expected 1.0, got ${score}`);
  });

  test("Unknown location scores 0.1", () => {
    const score = scoreLocation({ name: "Test", location: "Tokyo, Japan", community: "professional-ai" });
    if (score !== 0.1) throw new Error(`Expected 0.1, got ${score}`);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
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
  const command = parsed._command;

  try {
    let profile: ProfileInput;

    if (parsed.json) {
      profile = JSON.parse(parsed.json);
    } else {
      if (!parsed.name || !parsed.community) {
        console.error("Error: --name and --community are required (or use --json)");
        process.exit(1);
      }
      profile = {
        name: parsed.name,
        bio: parsed.bio,
        interests: parsed.interests
          ? parsed.interests.split(",").map((i: string) => i.trim())
          : undefined,
        location: parsed.location,
        community: parsed.community,
        occupation: parsed.occupation,
        projects: parsed.projects
          ? parsed.projects.split(",").map((p: string) => p.trim())
          : undefined,
      };
    }

    if (command === "deep") {
      const result = await analyzeProfileDeep(profile);
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "analyze") {
      const result = analyzeProfile(profile);
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Unknown command: ${command}. Use 'analyze' or 'deep'.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
