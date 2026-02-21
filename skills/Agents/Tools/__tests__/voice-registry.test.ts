/**
 * Voice Registry Schema Validation Tests
 *
 * Validates that all voice registry entries in Traits.yaml
 * have proper characteristics, descriptions, and settings.
 * Ensures zero "pending" placeholder entries remain.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  TraitsDataSchema,
  type TraitsData,
} from "../AgentFactory.ts";

const TRAITS_PATH = resolve(
  import.meta.dir,
  "../../Data/Traits.yaml",
);

/**
 * Load traits directly from the worktree's Traits.yaml, bypassing
 * the tiered config that reads from ~/.claude/skills/ (production path).
 * This ensures tests validate the file we actually modified.
 */
function loadTraitsFromWorktree(): TraitsData {
  const content = readFileSync(TRAITS_PATH, "utf-8");
  const parsed = parseYaml(content);
  const result = TraitsDataSchema.parse(parsed);
  return result;
}

describe("Traits.yaml schema validation", () => {
  let rawParsed: unknown;

  beforeAll(() => {
    const content = readFileSync(TRAITS_PATH, "utf-8");
    rawParsed = parseYaml(content);
  });

  test("full schema validates successfully with TraitsDataSchema", () => {
    const result = TraitsDataSchema.safeParse(rawParsed);
    expect(result.success).toBe(true);
  });

  test("rejects missing required top-level fields", () => {
    const incomplete = { expertise: {} };
    const result = TraitsDataSchema.safeParse(incomplete);
    expect(result.success).toBe(false);
  });

  test("rejects voice registry entry missing voice_id", () => {
    const bad = structuredClone(rawParsed) as Record<string, unknown>;
    const vm = bad["voice_mappings"] as Record<string, unknown>;
    const reg = vm["voice_registry"] as Record<string, Record<string, unknown>>;
    const firstKey = Object.keys(reg)[0];
    delete reg[firstKey]["voice_id"];
    const result = TraitsDataSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects voice registry entry missing characteristics", () => {
    const bad = structuredClone(rawParsed) as Record<string, unknown>;
    const vm = bad["voice_mappings"] as Record<string, unknown>;
    const reg = vm["voice_registry"] as Record<string, Record<string, unknown>>;
    const firstKey = Object.keys(reg)[0];
    delete reg[firstKey]["characteristics"];
    const result = TraitsDataSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe("voice registry completeness", () => {
  let traits: TraitsData;

  beforeAll(() => {
    traits = loadTraitsFromWorktree();
  });

  test("all entries have non-empty voice_id", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.voice_id.length).toBeGreaterThan(0);
    }
  });

  test("all entries have characteristics array with >= 2 items", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.characteristics.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("no entry has 'pending' in characteristics", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.characteristics).not.toContain("pending");
    }
  });

  test("all entries have descriptive description (not placeholder)", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.description).not.toContain("characterize after testing");
      expect(entry.description).not.toContain("New voice");
    }
  });

  test("all entries have stability in valid range (0.0 - 1.0)", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.stability).toBeGreaterThanOrEqual(0.0);
      expect(entry.stability).toBeLessThanOrEqual(1.0);
    }
  });

  test("all entries have similarity_boost in valid range (0.0 - 1.0)", () => {
    const registry = traits.voice_mappings.voice_registry;
    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.similarity_boost).toBeGreaterThanOrEqual(0.0);
      expect(entry.similarity_boost).toBeLessThanOrEqual(1.0);
    }
  });

  test("no duplicate voice_ids in registry", () => {
    const registry = traits.voice_mappings.voice_registry;
    const ids = Object.values(registry).map((e) => e.voice_id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test("voice registry has at least 41 entries (27 original + 14 new)", () => {
    const registry = traits.voice_mappings.voice_registry;
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(41);
  });

  test("newly characterized voices all present by name", () => {
    const registry = traits.voice_mappings.voice_registry;
    const newVoices = [
      "Kael", "Haseeb", "Liberty", "Hope", "Brittney",
      "Nolan", "Mariana", "Bradford", "Ravi", "Elena",
      "Manav", "Soren", "Peter", "Talia",
    ];
    for (const name of newVoices) {
      expect(registry[name]).toBeTruthy();
    }
  });

  test("new voices are wired into mappings", () => {
    const mappings = traits.voice_mappings.mappings;
    const newVoiceNames = new Set([
      "Kael", "Haseeb", "Liberty", "Hope", "Brittney",
      "Nolan", "Mariana", "Bradford", "Ravi", "Elena",
      "Manav", "Soren", "Peter", "Talia",
    ]);
    const mappedNewVoices = mappings.filter((m) =>
      newVoiceNames.has(m.voice),
    );
    // ISC #3: at least 6 of 14 new voices appear in mappings
    expect(mappedNewVoices.length).toBeGreaterThanOrEqual(6);
  });
});

describe("expertise, personality, approach schema", () => {
  let traits: TraitsData;

  beforeAll(() => {
    traits = loadTraitsFromWorktree();
  });

  test("all expertise entries have name and description", () => {
    for (const [key, def] of Object.entries(traits.expertise)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  test("all personality entries have name, description, and prompt_fragment", () => {
    for (const [key, def] of Object.entries(traits.personality)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.prompt_fragment).toBeTruthy();
    }
  });

  test("all approach entries have name, description, and prompt_fragment", () => {
    for (const [key, def] of Object.entries(traits.approach)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.prompt_fragment).toBeTruthy();
    }
  });
});
