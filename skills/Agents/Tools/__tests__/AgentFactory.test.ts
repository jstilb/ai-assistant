/**
 * AgentFactory Unit Tests
 *
 * Tests inferTraitsFromTask(), resolveVoice(), composeAgent()
 * Target: >=80% line coverage on AgentFactory.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { resolve } from "path";
import {
  inferTraitsFromTask,
  resolveVoice,
  composeAgent,
  loadTemplate,
  loadTraits,
  listTraits,
  validateTraitKeys,
  formatAgentOutput,
  collectTraitKeys,
  run,
  TraitsDataSchema,
  type TraitsData,
} from "../AgentFactory.ts";

const TRAITS_PATH = resolve(import.meta.dir, "../../Data/Traits.yaml");

/**
 * Load traits directly from the worktree's Traits.yaml (not tiered config).
 */
function loadTraitsFromWorktree(): TraitsData {
  const content = readFileSync(TRAITS_PATH, "utf-8");
  const parsed = parseYaml(content);
  return TraitsDataSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Fixture: minimal but structurally complete TraitsData for isolated tests
// ---------------------------------------------------------------------------
function createTestTraits(): TraitsData {
  return {
    expertise: {
      security: {
        name: "Security Expert",
        description: "Security knowledge",
        keywords: ["vulnerability", "security", "attack", "exploit"],
      },
      technical: {
        name: "Technical Specialist",
        description: "Software architecture",
        keywords: ["code", "architecture", "system", "API"],
      },
      research: {
        name: "Research Specialist",
        description: "Research methodology",
        keywords: ["research", "study", "evidence"],
      },
      creative: {
        name: "Creative Specialist",
        description: "Content creation",
        keywords: ["creative", "content", "story", "design"],
      },
    },
    personality: {
      skeptical: {
        name: "Skeptical",
        description: "Questions assumptions",
        prompt_fragment: "You approach all claims with healthy skepticism.",
        keywords: ["skeptic", "question"],
      },
      analytical: {
        name: "Analytical",
        description: "Data-driven, logical",
        prompt_fragment: "You approach problems analytically.",
      },
      enthusiastic: {
        name: "Enthusiastic",
        description: "Excited about discoveries",
        prompt_fragment: "You bring genuine enthusiasm.",
        keywords: ["exciting", "excited"],
      },
      empathetic: {
        name: "Empathetic",
        description: "Considers human impact",
        prompt_fragment: "You consider the human element.",
      },
      bold: {
        name: "Bold",
        description: "Strong claims",
        prompt_fragment: "You make strong claims.",
      },
    },
    approach: {
      thorough: {
        name: "Thorough",
        description: "Exhaustive analysis",
        prompt_fragment: "Be exhaustive in your analysis.",
        keywords: ["thorough", "comprehensive", "exhaustive"],
      },
      rapid: {
        name: "Rapid",
        description: "Quick assessment",
        prompt_fragment: "Move quickly and efficiently.",
        keywords: ["quick", "fast", "rapid"],
      },
      systematic: {
        name: "Systematic",
        description: "Structured approach",
        prompt_fragment: "Follow a clear, structured methodology.",
      },
      adversarial: {
        name: "Adversarial",
        description: "Red team approach",
        prompt_fragment: "Take an adversarial stance.",
        keywords: ["adversarial", "red team", "attack"],
      },
      exploratory: {
        name: "Exploratory",
        description: "Discovery-oriented",
        prompt_fragment: "Follow interesting threads.",
        keywords: ["explore", "discover"],
      },
    },
    voice_mappings: {
      default: "Daniel",
      default_voice_id: "onwK4e9ZLuTAKqWW03F9",
      voice_registry: {
        Daniel: {
          voice_id: "onwK4e9ZLuTAKqWW03F9",
          characteristics: ["authoritative", "measured", "intellectual"],
          description: "Deep British male",
          stability: 0.7,
          similarity_boost: 0.85,
        },
        George: {
          voice_id: "JBFqnCBsd6RMkjVDRZzb",
          characteristics: ["intellectual", "warm", "academic"],
          description: "Raspy British male",
          stability: 0.62,
          similarity_boost: 0.8,
        },
        Clyde: {
          voice_id: "2EiwWnXFnvU5JabPnv8n",
          characteristics: ["edgy", "gravelly", "intense"],
          description: "Deep gravelly American male",
          stability: 0.55,
          similarity_boost: 0.75,
        },
        Jeremy: {
          voice_id: "bVMeCyTHy58xNoL34h3p",
          characteristics: ["energetic", "excited", "dynamic"],
          description: "Excited young American-Irish male",
          stability: 0.35,
          similarity_boost: 0.65,
        },
        Matilda: {
          voice_id: "XrExE9yKIg1WjnnlVkGX",
          characteristics: ["warm", "friendly", "engaging"],
          description: "Warm American female",
          stability: 0.5,
          similarity_boost: 0.75,
        },
      },
      mappings: [
        {
          traits: ["skeptical", "analytical"],
          voice: "George",
          voice_id: "JBFqnCBsd6RMkjVDRZzb",
          reason: "Skeptical analysis suits academic warmth",
        },
        {
          traits: ["enthusiastic", "creative"],
          voice: "Jeremy",
          voice_id: "bVMeCyTHy58xNoL34h3p",
          reason: "Creative enthusiasm needs high-energy delivery",
        },
        {
          traits: ["empathetic", "thorough"],
          voice: "Matilda",
          voice_id: "XrExE9yKIg1WjnnlVkGX",
          reason: "Thorough empathy suits warm friendliness",
        },
        {
          traits: ["bold", "adversarial"],
          voice: "Clyde",
          voice_id: "2EiwWnXFnvU5JabPnv8n",
          reason: "Adversarial boldness suits gravelly intensity",
        },
      ],
      fallbacks: {
        skeptical: "George",
        skeptical_voice_id: "JBFqnCBsd6RMkjVDRZzb",
        enthusiastic: "Jeremy",
        enthusiastic_voice_id: "bVMeCyTHy58xNoL34h3p",
        analytical: "Daniel",
        analytical_voice_id: "onwK4e9ZLuTAKqWW03F9",
        empathetic: "Matilda",
        empathetic_voice_id: "XrExE9yKIg1WjnnlVkGX",
      },
    },
    examples: {
      security_audit: {
        description: "Security architecture review",
        traits: ["security", "skeptical", "thorough", "adversarial"],
      },
    },
  };
}

// ===========================================================================
// inferTraitsFromTask()
// ===========================================================================
describe("inferTraitsFromTask", () => {
  const traits = createTestTraits();

  test("infers expertise from matching keyword", () => {
    const result = inferTraitsFromTask("Review this security architecture", traits);
    expect(result).toContain("security");
  });

  test("infers multiple expertise from overlapping keywords", () => {
    const result = inferTraitsFromTask(
      "security code review of the system architecture",
      traits,
    );
    expect(result).toContain("security");
    expect(result).toContain("technical");
  });

  test("infers approach from matching keyword", () => {
    const result = inferTraitsFromTask("Do a thorough comprehensive review", traits);
    expect(result).toContain("thorough");
  });

  test("infers personality from matching keyword", () => {
    const result = inferTraitsFromTask("This is an exciting new discovery", traits);
    expect(result).toContain("enthusiastic");
  });

  test("applies default personality (analytical) when no personality keyword matches", () => {
    const result = inferTraitsFromTask("Review this security plan", traits);
    expect(result).toContain("analytical");
  });

  test("applies default approach (thorough) when no approach keyword matches", () => {
    const result = inferTraitsFromTask("security vulnerability scan", traits);
    // "thorough" should be default approach since no approach keyword matched
    // but "thorough" keyword is not in "security vulnerability scan"
    // The task has "security" expertise keyword but no approach keyword
    expect(result).toContain("thorough");
  });

  test("applies default expertise (research) when no expertise keyword matches", () => {
    const result = inferTraitsFromTask("Do something interesting quickly", traits);
    expect(result).toContain("research");
  });

  test("deduplicates inferred traits", () => {
    // "attack" matches both security.keywords and adversarial.keywords
    const result = inferTraitsFromTask("attack the security with adversarial attack", traits);
    const uniqueResult = [...new Set(result)];
    expect(result.length).toBe(uniqueResult.length);
  });

  test("no-match task gets all three defaults", () => {
    const result = inferTraitsFromTask("just a random sentence", traits);
    expect(result).toContain("analytical"); // default personality
    expect(result).toContain("thorough");   // default approach
    expect(result).toContain("research");   // default expertise
  });

  test("case-insensitive keyword matching", () => {
    const result = inferTraitsFromTask("SECURITY VULNERABILITY EXPLOIT", traits);
    expect(result).toContain("security");
  });

  test("matches multiple categories simultaneously", () => {
    // security = expertise, adversarial approach keyword = "attack"
    const result = inferTraitsFromTask("attack the security with a red team approach", traits);
    expect(result).toContain("security");    // expertise
    expect(result).toContain("adversarial"); // approach
    // should still get default personality since no personality keyword matched
    expect(result).toContain("analytical");
  });
});

// ===========================================================================
// resolveVoice()
// ===========================================================================
describe("resolveVoice", () => {
  const traits = createTestTraits();

  test("exact combo match from mappings", () => {
    const result = resolveVoice(["skeptical", "analytical"], traits);
    expect(result.voice).toBe("George");
    expect(result.voiceId).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  test("superset of mapping traits still matches", () => {
    // Has skeptical + analytical + security; mapping requires skeptical + analytical
    const result = resolveVoice(
      ["skeptical", "analytical", "security"],
      traits,
    );
    expect(result.voice).toBe("George");
  });

  test("more specific mapping wins over less specific", () => {
    // Both ["skeptical","analytical"] and potentially single-trait fallbacks match
    const result = resolveVoice(["skeptical", "analytical", "thorough"], traits);
    expect(result.voice).toBe("George");
  });

  test("single-trait fallback when no combo matches", () => {
    const result = resolveVoice(["skeptical"], traits);
    expect(result.voice).toBe("George");
    expect(result.reason).toContain("Fallback for trait");
  });

  test("fallback voice_id is resolved from registry when not in fallback key", () => {
    const result = resolveVoice(["skeptical"], traits);
    expect(result.voiceId).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  test("default voice when no mapping or fallback matches", () => {
    const result = resolveVoice(["systematic"], traits);
    expect(result.voice).toBe("Daniel");
    expect(result.voiceId).toBe("onwK4e9ZLuTAKqWW03F9");
    expect(result.reason).toContain("Default voice");
  });

  test("empty traits returns default", () => {
    const result = resolveVoice([], traits);
    expect(result.voice).toBe("Daniel");
    expect(result.voiceId).toBe("onwK4e9ZLuTAKqWW03F9");
  });

  test("mapping voice_id takes priority over registry lookup", () => {
    // The mapping for ["bold","adversarial"] has voice_id directly
    const result = resolveVoice(["bold", "adversarial"], traits);
    expect(result.voice).toBe("Clyde");
    expect(result.voiceId).toBe("2EiwWnXFnvU5JabPnv8n");
  });

  test("reason includes matched traits for combo match", () => {
    const result = resolveVoice(["enthusiastic", "creative"], traits);
    expect(result.reason).toBe("Creative enthusiasm needs high-energy delivery");
  });
});

// ===========================================================================
// composeAgent()
// ===========================================================================
describe("composeAgent", () => {
  let traits: TraitsData;

  beforeAll(() => {
    traits = loadTraitsFromWorktree();
  });

  test("produces valid ComposedAgent with all required fields", () => {
    const agent = composeAgent(
      ["security", "skeptical", "thorough"],
      "Review security architecture",
      traits,
    );
    expect(agent.name).toBeTruthy();
    expect(agent.traits).toEqual(["security", "skeptical", "thorough"]);
    expect(agent.expertise.length).toBeGreaterThan(0);
    expect(agent.personality.length).toBeGreaterThan(0);
    expect(agent.approach.length).toBeGreaterThan(0);
    expect(agent.voice).toBeTruthy();
    expect(agent.voiceId).toBeTruthy();
    expect(agent.prompt).toBeTruthy();
  });

  test("prompt contains task text", () => {
    const task = "Analyze the deployment pipeline for vulnerabilities";
    const agent = composeAgent(["security", "analytical", "thorough"], task, traits);
    expect(agent.prompt).toContain(task);
  });

  test("prompt contains voice assignment", () => {
    const agent = composeAgent(
      ["security", "skeptical", "thorough"],
      "Test task",
      traits,
    );
    expect(agent.prompt).toContain(agent.voice);
    expect(agent.prompt).toContain(agent.voiceId);
  });

  test("name is composed from trait names", () => {
    const agent = composeAgent(
      ["security", "analytical", "thorough"],
      "Test task",
      traits,
    );
    // Name should include first expertise, first personality, first approach
    expect(agent.name).toContain("Security Expert");
    expect(agent.name).toContain("Analytical");
    expect(agent.name).toContain("Thorough");
  });

  test("agent with empty task still produces valid prompt", () => {
    const agent = composeAgent(["analytical", "thorough"], "", traits);
    expect(agent.prompt).toBeTruthy();
    expect(agent.prompt.length).toBeGreaterThan(100);
  });

  test("expertise, personality, and approach arrays are populated correctly", () => {
    const agent = composeAgent(
      ["technical", "cautious", "systematic"],
      "Code review",
      traits,
    );
    expect(agent.expertise.some((e) => e.name === "Technical Specialist")).toBe(true);
    expect(agent.personality.some((p) => p.name === "Cautious")).toBe(true);
    expect(agent.approach.some((a) => a.name === "Systematic")).toBe(true);
  });

  test("voice and voiceId are populated", () => {
    const agent = composeAgent(
      ["research", "empathetic", "exploratory"],
      "User research project",
      traits,
    );
    expect(agent.voice.length).toBeGreaterThan(0);
    expect(agent.voiceId.length).toBeGreaterThan(0);
  });

  test("voiceReason is populated", () => {
    const agent = composeAgent(
      ["security", "skeptical", "thorough"],
      "Test task",
      traits,
    );
    expect(agent.voiceReason.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// loadTraits() integration
// ===========================================================================
// ===========================================================================
// loadTemplate()
// ===========================================================================
describe("loadTemplate", () => {
  test("loads and compiles the Handlebars template", () => {
    const template = loadTemplate();
    expect(typeof template).toBe("function");
  });

  test("compiled template renders with data", () => {
    const template = loadTemplate();
    const result = template({
      name: "Test Agent",
      task: "Do a thing",
      expertise: [{ name: "TestExpert", description: "Test description" }],
      personality: [{ name: "TestPersonality", prompt_fragment: "Be testing." }],
      approach: [{ name: "TestApproach", prompt_fragment: "Test approach." }],
      voice: "TestVoice",
      voiceId: "test-id-123",
    });
    expect(result).toContain("Test Agent");
    expect(result).toContain("Do a thing");
    expect(result).toContain("TestVoice");
    expect(result).toContain("test-id-123");
  });
});

// ===========================================================================
// listTraits()
// ===========================================================================
describe("listTraits", () => {
  test("logs trait information to console", () => {
    const traits = loadTraitsFromWorktree();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      listTraits(traits);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("AVAILABLE TRAITS");
    expect(output).toContain("EXPERTISE");
    expect(output).toContain("PERSONALITY");
    expect(output).toContain("APPROACH");
    expect(output).toContain("EXAMPLE COMPOSITIONS");
    expect(output).toContain("security");
    expect(output).toContain("skeptical");
    expect(output).toContain("thorough");
  });
});

// ===========================================================================
// resolveVoice edge cases (getVoiceId helper coverage)
// ===========================================================================
describe("resolveVoice edge cases", () => {
  test("getVoiceId falls back to registry when mapping has no voice_id", () => {
    const traits = createTestTraits();
    // Remove voice_id from a mapping to test registry fallback
    traits.voice_mappings.mappings[0].voice_id = undefined;
    const result = resolveVoice(["skeptical", "analytical"], traits);
    // Should still find George's ID from registry
    expect(result.voice).toBe("George");
    expect(result.voiceId).toBe("JBFqnCBsd6RMkjVDRZzb");
  });

  test("uses mapping reason when available", () => {
    const traits = createTestTraits();
    const result = resolveVoice(["bold", "adversarial"], traits);
    expect(result.reason).toBe("Adversarial boldness suits gravelly intensity");
  });

  test("fallback voice_id uses explicit _voice_id key", () => {
    const traits = createTestTraits();
    const result = resolveVoice(["enthusiastic"], traits);
    expect(result.voice).toBe("Jeremy");
    expect(result.voiceId).toBe("bVMeCyTHy58xNoL34h3p");
  });

  test("handles voice not in registry gracefully", () => {
    const traits = createTestTraits();
    // Add a fallback for a voice not in the registry
    traits.voice_mappings.fallbacks["nonexistent_trait"] = "GhostVoice";
    const result = resolveVoice(["nonexistent_trait"], traits);
    expect(result.voice).toBe("GhostVoice");
    // voiceId should fall back to default since voice is not in registry
    expect(result.voiceId).toBe(traits.voice_mappings.default_voice_id);
  });

  test("handles empty voice_registry gracefully", () => {
    const traits = createTestTraits();
    traits.voice_mappings.voice_registry = {};
    const result = resolveVoice(["analytical"], traits);
    expect(result.voice).toBe("Daniel");
    expect(result.voiceId).toBe("onwK4e9ZLuTAKqWW03F9");
  });
});

// ===========================================================================
// composeAgent additional coverage
// ===========================================================================
describe("composeAgent additional scenarios", () => {
  let traits: TraitsData;

  beforeAll(() => {
    traits = loadTraitsFromWorktree();
  });

  test("agent name defaults to 'Dynamic Agent' when no traits match any category", () => {
    // Use test fixture with non-existent keys (but valid in the real data)
    const fixture = createTestTraits();
    // composeAgent with keys that don't exist in any category
    const agent = composeAgent([], "", fixture);
    expect(agent.name).toBe("Dynamic Agent");
  });

  test("only expertise traits appear in expertise array", () => {
    const agent = composeAgent(
      ["security", "technical", "skeptical", "thorough"],
      "Full test",
      traits,
    );
    for (const e of agent.expertise) {
      expect(["Security Expert", "Technical Specialist"]).toContain(e.name);
    }
    expect(agent.expertise.length).toBe(2);
  });

  test("prompt contains domain expertise section for expertise traits", () => {
    const agent = composeAgent(["security", "analytical", "thorough"], "Test", traits);
    expect(agent.prompt).toContain("Domain Expertise");
  });

  test("prompt contains personality section for personality traits", () => {
    const agent = composeAgent(["security", "skeptical", "thorough"], "Test", traits);
    expect(agent.prompt).toContain("Personality");
  });

  test("prompt contains approach section for approach traits", () => {
    const agent = composeAgent(["security", "analytical", "thorough"], "Test", traits);
    expect(agent.prompt).toContain("Approach");
  });

  test("prompt contains operational guidelines", () => {
    const agent = composeAgent(["analytical", "thorough"], "Test", traits);
    expect(agent.prompt).toContain("Operational Guidelines");
  });

  test("prompt contains response format", () => {
    const agent = composeAgent(["analytical", "thorough"], "Test", traits);
    expect(agent.prompt).toContain("COMPLETED");
  });
});

// ===========================================================================
// validateTraitKeys()
// ===========================================================================
describe("validateTraitKeys", () => {
  const traits = createTestTraits();

  test("returns empty array for all valid traits", () => {
    const invalid = validateTraitKeys(["security", "skeptical", "thorough"], traits);
    expect(invalid).toEqual([]);
  });

  test("returns invalid trait names", () => {
    const invalid = validateTraitKeys(["security", "nonexistent", "fakeTrait"], traits);
    expect(invalid).toContain("nonexistent");
    expect(invalid).toContain("fakeTrait");
    expect(invalid).not.toContain("security");
  });

  test("returns empty array for empty input", () => {
    const invalid = validateTraitKeys([], traits);
    expect(invalid).toEqual([]);
  });
});

// ===========================================================================
// collectTraitKeys()
// ===========================================================================
describe("collectTraitKeys", () => {
  const traits = createTestTraits();

  test("collects from explicit traits string", () => {
    const keys = collectTraitKeys("security,skeptical,thorough", undefined, traits);
    expect(keys).toContain("security");
    expect(keys).toContain("skeptical");
    expect(keys).toContain("thorough");
  });

  test("collects from task inference", () => {
    const keys = collectTraitKeys(undefined, "security vulnerability scan", traits);
    expect(keys).toContain("security");
  });

  test("merges explicit and inferred traits, deduplicating", () => {
    const keys = collectTraitKeys("bold", "security audit", traits);
    expect(keys).toContain("bold");
    expect(keys).toContain("security");
    // No duplicates
    expect(keys.length).toBe(new Set(keys).size);
  });

  test("returns empty for no explicit and no task", () => {
    const keys = collectTraitKeys(undefined, undefined, traits);
    expect(keys).toEqual([]);
  });

  test("trims and lowercases explicit traits", () => {
    const keys = collectTraitKeys("  Security , SKEPTICAL  ", undefined, traits);
    expect(keys).toContain("security");
    expect(keys).toContain("skeptical");
  });
});

// ===========================================================================
// formatAgentOutput()
// ===========================================================================
describe("formatAgentOutput", () => {
  let traits: TraitsData;
  let agent: ReturnType<typeof composeAgent>;

  beforeAll(() => {
    traits = loadTraitsFromWorktree();
    agent = composeAgent(["security", "skeptical", "thorough"], "Test task", traits);
  });

  test("json format produces valid JSON with all fields", () => {
    const output = formatAgentOutput(agent, "json", "Test task", false);
    const parsed = JSON.parse(output);
    expect(parsed.name).toBeTruthy();
    expect(parsed.traits).toBeInstanceOf(Array);
    expect(parsed.voice).toBeTruthy();
    expect(parsed.voice_id).toBeTruthy();
    expect(parsed.prompt).toBeTruthy();
    expect(parsed.expertise).toBeInstanceOf(Array);
    expect(parsed.personality).toBeInstanceOf(Array);
    expect(parsed.approach).toBeInstanceOf(Array);
  });

  test("json format with team includes teamMemberSpec", () => {
    const output = formatAgentOutput(agent, "json", "Test task", true);
    const parsed = JSON.parse(output);
    expect(parsed.teamMemberSpec).toBeTruthy();
    expect(parsed.teamMemberSpec.role).toBeTruthy();
    expect(parsed.teamMemberSpec.task).toBe("Test task");
    expect(parsed.teamMemberSpec.model).toBe("sonnet"); // default model
    expect(parsed.teamMemberSpec.context).toBeTruthy();
  });

  test("json format team model selection: opus trait", () => {
    const opusAgent = { ...agent, traits: [...agent.traits, "opus"] };
    const output = formatAgentOutput(opusAgent, "json", "Test", true);
    const parsed = JSON.parse(output);
    expect(parsed.teamMemberSpec.model).toBe("opus");
  });

  test("json format team model selection: haiku trait", () => {
    const haikuAgent = { ...agent, traits: [...agent.traits, "haiku"] };
    const output = formatAgentOutput(haikuAgent, "json", "Test", true);
    const parsed = JSON.parse(output);
    expect(parsed.teamMemberSpec.model).toBe("haiku");
  });

  test("yaml format produces key-value output", () => {
    const output = formatAgentOutput(agent, "yaml", "Test task", false);
    expect(output).toContain("name:");
    expect(output).toContain("voice:");
    expect(output).toContain("voice_id:");
    expect(output).toContain("voice_reason:");
    expect(output).toContain("traits:");
    expect(output).toContain("expertise:");
    expect(output).toContain("personality:");
    expect(output).toContain("approach:");
  });

  test("summary format produces readable output", () => {
    const output = formatAgentOutput(agent, "summary", "Test task", false);
    expect(output).toContain("COMPOSED AGENT:");
    expect(output).toContain("Traits:");
    expect(output).toContain("Expertise:");
    expect(output).toContain("Personality:");
    expect(output).toContain("Approach:");
    expect(output).toContain("Voice:");
  });

  test("default format returns full prompt", () => {
    const output = formatAgentOutput(agent, "prompt", "Test task", false);
    expect(output).toBe(agent.prompt);
  });

  test("unknown format returns full prompt", () => {
    const output = formatAgentOutput(agent, "unknown_format", "Test task", false);
    expect(output).toBe(agent.prompt);
  });

  test("summary with empty expertise shows 'General'", () => {
    const noExpertise = { ...agent, expertise: [] };
    const output = formatAgentOutput(noExpertise, "summary", "Test", false);
    expect(output).toContain("General");
  });

  test("json team slugifies role correctly", () => {
    const weirdName = { ...agent, name: "Security Expert Skeptical Thorough" };
    const output = formatAgentOutput(weirdName, "json", "Test", true);
    const parsed = JSON.parse(output);
    expect(parsed.teamMemberSpec.role).toBe("security-expert-skeptical-thorough");
  });
});

// ===========================================================================
// run() - in-process CLI orchestration
// ===========================================================================
describe("run", () => {
  test("--help returns help text", () => {
    const output = run({ help: true });
    expect(output).toContain("AgentFactory");
    expect(output).toContain("USAGE");
    expect(output).toContain("OPTIONS");
    expect(output).toContain("EXAMPLES");
  });

  test("--list calls listTraits and returns null", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const output = run({ list: true });
      expect(output).toBeNull();
      expect(logs.join("\n")).toContain("AVAILABLE TRAITS");
    } finally {
      console.log = origLog;
    }
  });

  test("--task returns prompt output", () => {
    const output = run({ task: "Review security architecture" });
    expect(output).toBeTruthy();
    expect(output).toContain("Dynamic Agent");
    expect(output).toContain("Review security architecture");
  });

  test("--traits returns prompt output", () => {
    const output = run({ traits: "security,skeptical,thorough" });
    expect(output).toBeTruthy();
    expect(output).toContain("Dynamic Agent");
  });

  test("--output json returns valid JSON", () => {
    const output = run({ task: "Analyze competitors", output: "json" });
    expect(output).toBeTruthy();
    const parsed = JSON.parse(output!);
    expect(parsed.name).toBeTruthy();
    expect(parsed.traits).toBeInstanceOf(Array);
  });

  test("--output json --team includes teamMemberSpec", () => {
    const output = run({
      task: "Analyze competitors",
      output: "json",
      team: true,
    });
    const parsed = JSON.parse(output!);
    expect(parsed.teamMemberSpec).toBeTruthy();
    expect(parsed.teamMemberSpec.role).toBeTruthy();
    expect(parsed.teamMemberSpec.task).toBe("Analyze competitors");
  });

  test("--output yaml returns YAML format", () => {
    const output = run({ task: "Code review", output: "yaml" });
    expect(output).toContain("name:");
    expect(output).toContain("voice:");
    expect(output).toContain("traits:");
  });

  test("--output summary returns summary format", () => {
    const output = run({ task: "Market analysis", output: "summary" });
    expect(output).toContain("COMPOSED AGENT:");
    expect(output).toContain("Traits:");
  });

  test("combined --task and --traits merges", () => {
    const output = run({
      task: "security audit",
      traits: "bold",
      output: "json",
    });
    const parsed = JSON.parse(output!);
    expect(parsed.traits).toContain("bold");
    expect(parsed.traits).toContain("security");
  });
});

// ===========================================================================
// CLI integration tests (subprocess execution for main() coverage)
// ===========================================================================
describe("AgentFactory CLI", () => {
  const FACTORY_PATH = resolve(import.meta.dir, "../AgentFactory.ts");

  test("--list outputs available traits", async () => {
    const proc = Bun.spawn(["bun", "run", FACTORY_PATH, "--list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AVAILABLE TRAITS");
    expect(stdout).toContain("EXPERTISE");
    expect(stdout).toContain("PERSONALITY");
    expect(stdout).toContain("APPROACH");
  });

  test("--help outputs usage information", async () => {
    const proc = Bun.spawn(["bun", "run", FACTORY_PATH, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AgentFactory");
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("OPTIONS");
  });

  test("--task produces prompt output", async () => {
    const proc = Bun.spawn(
      ["bun", "run", FACTORY_PATH, "--task", "Review security architecture"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dynamic Agent");
    expect(stdout).toContain("Review security architecture");
  });

  test("--traits produces prompt output", async () => {
    const proc = Bun.spawn(
      ["bun", "run", FACTORY_PATH, "--traits", "security,skeptical,thorough"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dynamic Agent");
  });

  test("--output json produces valid JSON", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", FACTORY_PATH,
        "--task", "Analyze competitors",
        "--output", "json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBeTruthy();
    expect(parsed.traits).toBeInstanceOf(Array);
    expect(parsed.voice).toBeTruthy();
    expect(parsed.voice_id).toBeTruthy();
    expect(parsed.prompt).toBeTruthy();
  });

  test("--output json --team includes teamMemberSpec", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", FACTORY_PATH,
        "--task", "Analyze competitors",
        "--output", "json",
        "--team",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.teamMemberSpec).toBeTruthy();
    expect(parsed.teamMemberSpec.role).toBeTruthy();
    expect(parsed.teamMemberSpec.task).toBe("Analyze competitors");
    expect(parsed.teamMemberSpec.model).toBeTruthy();
    expect(parsed.teamMemberSpec.context).toBeTruthy();
  });

  test("--output yaml produces YAML output", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", FACTORY_PATH,
        "--task", "Review code",
        "--output", "yaml",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("name:");
    expect(stdout).toContain("voice:");
    expect(stdout).toContain("traits:");
  });

  test("--output summary produces summary output", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", FACTORY_PATH,
        "--task", "Market analysis",
        "--output", "summary",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("COMPOSED AGENT:");
    expect(stdout).toContain("Traits:");
    expect(stdout).toContain("Voice:");
  });

  test("no args exits with error", async () => {
    const proc = Bun.spawn(["bun", "run", FACTORY_PATH], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });

  test("invalid traits exits with error", async () => {
    const proc = Bun.spawn(
      ["bun", "run", FACTORY_PATH, "--traits", "nonexistent_trait_xyz"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown traits");
  });

  test("--task and --traits combined merges traits", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", FACTORY_PATH,
        "--task", "security audit",
        "--traits", "bold",
        "--output", "json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.traits).toContain("bold");
    expect(parsed.traits).toContain("security"); // inferred from task
  });
});

// ===========================================================================
// loadTraits() - actual function (loads from tiered config / legacy path)
// ===========================================================================
describe("loadTraits (production path)", () => {
  test("loads traits successfully from legacy or tiered config", () => {
    const traits = loadTraits();
    expect(traits).toBeTruthy();
    expect(Object.keys(traits.expertise).length).toBeGreaterThan(0);
    expect(Object.keys(traits.personality).length).toBeGreaterThan(0);
    expect(Object.keys(traits.approach).length).toBeGreaterThan(0);
  });

  test("loaded traits have valid voice_mappings structure", () => {
    const traits = loadTraits();
    expect(traits.voice_mappings.default).toBeTruthy();
    expect(traits.voice_mappings.default_voice_id).toBeTruthy();
    expect(traits.voice_mappings.voice_registry).toBeTruthy();
    expect(traits.voice_mappings.mappings.length).toBeGreaterThan(0);
    expect(Object.keys(traits.voice_mappings.fallbacks).length).toBeGreaterThan(0);
  });

  test("loaded traits have examples", () => {
    const traits = loadTraits();
    expect(Object.keys(traits.examples).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// loadTraitsFromWorktree integration
// ===========================================================================
describe("loadTraitsFromWorktree", () => {
  test("loads and validates Traits.yaml successfully", () => {
    const traits = loadTraitsFromWorktree();
    expect(traits).toBeTruthy();
    expect(Object.keys(traits.expertise).length).toBeGreaterThan(0);
    expect(Object.keys(traits.personality).length).toBeGreaterThan(0);
    expect(Object.keys(traits.approach).length).toBeGreaterThan(0);
    expect(traits.voice_mappings).toBeTruthy();
    expect(traits.voice_mappings.mappings.length).toBeGreaterThan(0);
  });

  test("voice registry has all expected voices", () => {
    const traits = loadTraitsFromWorktree();
    const registry = traits.voice_mappings.voice_registry;
    // Original 27 + 14 new = 41 voices
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(41);
  });
});
