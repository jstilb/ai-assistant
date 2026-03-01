/**
 * Skill Routing Eval — ISC #7128
 *
 * Exercises the ContextRouter's intent classification against the live
 * IntentClassifier with ≥5 distinct skill intents. Uses the project-local
 * routing.json so this runs without the full ~/.claude installation.
 *
 * Self-contained: mocks Inference (no API calls) and SkillIntegrationBridge
 * (no side effects) so the test runs in CI without Kaya infrastructure.
 */

import { describe, test, expect, mock } from "bun:test";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "../..");

// Mock side-effect dependencies so the test is self-contained
mock.module(`${PROJECT_ROOT}/skills/CORE/Tools/SkillIntegrationBridge`, () => ({
  emitInsight: () => Promise.resolve(""),
}));

// Mock inference to avoid real API calls — keyword stage must resolve without it
// If Stage B (inference) is reached, return a 'general' profile
mock.module(`${PROJECT_ROOT}/skills/CORE/Tools/Inference`, () => ({
  inference: () =>
    Promise.resolve({
      success: true,
      parsed: { profile: "general", confidence: 0.7, reasoning: "mocked" },
    }),
}));

// Point KAYA_DIR at the project root so routing.json is read from the repo
process.env.KAYA_DIR = PROJECT_ROOT;

// Import after mocks + env are set
const { classifyIntent } = await import(
  `${PROJECT_ROOT}/skills/ContextManager/Tools/IntentClassifier`
);

// ---------------------------------------------------------------------------
// Routing eval cases — ≥5 distinct target skill profiles
// ---------------------------------------------------------------------------

interface RoutingCase {
  intent: string;
  prompt: string;
  expectedProfile: string;
  description: string;
}

const routingCases: RoutingCase[] = [
  // Intent 1: development (code / bug fixing)
  {
    intent: "code-fix",
    prompt: "fix the authentication bug in the login module",
    expectedProfile: "development",
    description: "Bug fix intent should route to development profile",
  },
  // Intent 2: scheduling (calendar / meetings)
  {
    intent: "calendar-lookup",
    prompt: "what meetings do I have tomorrow on my calendar",
    expectedProfile: "scheduling",
    description: "Calendar query should route to scheduling profile",
  },
  // Intent 3: task-management (tasks / deadlines)
  {
    intent: "task-query",
    prompt: "what tasks are overdue in my queue",
    expectedProfile: "task-management",
    description: "Task query should route to task-management profile",
  },
  // Intent 4: life-coaching (goals / habits)
  {
    intent: "goal-review",
    prompt: "review my challenge progress and goal alignment",
    expectedProfile: "life-coaching",
    description: "Goal review should route to life-coaching profile",
  },
  // Intent 5: planning (week planning)
  {
    intent: "week-planning",
    prompt: "plan my week and prioritize my goals",
    expectedProfile: "planning",
    description: "Week planning should route to planning profile",
  },
  // Intent 6: knowledge-lookup (research / notes)
  {
    intent: "knowledge-lookup",
    prompt: "what do my notes say about the architecture decision",
    expectedProfile: "knowledge-lookup",
    description: "Notes query should route to knowledge-lookup profile",
  },
];

describe("Skill Routing Eval (ISC #7128)", () => {
  test("covers at least 5 distinct skill intents", () => {
    const distinctProfiles = new Set(routingCases.map((c) => c.expectedProfile));
    expect(distinctProfiles.size).toBeGreaterThanOrEqual(5);
  });

  // Run per-intent routing accuracy tests
  for (const c of routingCases) {
    test(`[${c.intent}] ${c.description}`, async () => {
      const result = await classifyIntent(c.prompt, false);

      // Confirm routing hit the correct profile
      expect(result.profile).toBe(c.expectedProfile);

      // Confirm result has required fields
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThan(0);
      expect(["keyword", "inference"]).toContain(result.stage);
      expect(typeof result.timestamp).toBe("string");
    });
  }

  test("keyword stage resolves for clear intents without API calls", async () => {
    // These high-signal prompts must resolve via keyword match (Stage A), not inference
    const highSignalCases = [
      { prompt: "fix the bug in the typescript code", expectedStage: "keyword" },
      { prompt: "what meetings do I have tomorrow", expectedStage: "keyword" },
      { prompt: "plan my week ahead", expectedStage: "keyword" },
    ];

    for (const { prompt, expectedStage } of highSignalCases) {
      const result = await classifyIntent(prompt, false);
      expect(result.stage).toBe(expectedStage);
    }
  });

  test("all routing cases return a valid profile string", async () => {
    for (const c of routingCases) {
      const result = await classifyIntent(c.prompt, false);
      expect(typeof result.profile).toBe("string");
      expect(result.profile.length).toBeGreaterThan(0);
    }
  });
});
