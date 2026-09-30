/**
 * VoiceSystemPrompt.test.ts - Tests for voice-optimized system prompt builder
 *
 * Tests: buildVoiceSystemPrompt, extractPersonalityTraits, getMinimalContext,
 * personality caching, identity loading/overrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";

// Mock fs module
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  };
});

// Mock ConfigLoader
vi.mock("../../../../lib/core/ConfigLoader.ts", () => ({
  loadSettings: vi.fn(() => ({
    daidentity: { name: "Kaya", voice: {} },
    principal: { name: "Jm", timezone: "America/Los_Angeles" },
  })),
}));

// Mock VoiceCommon identity
vi.mock("../VoiceCommon.ts", () => ({
  KAYA_HOME: "/mock/home/.claude",
  getIdentity: vi.fn(() => ({
    assistantName: "Kaya",
    userName: "Jm",
  })),
}));

import {
  buildVoiceSystemPrompt,
  getMinimalContext,
  invalidatePersonalityCache,
  extractPersonalityTraits,
} from "../VoiceSystemPrompt.ts";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

// ============================================================================
// Tests
// ============================================================================

describe("buildVoiceSystemPrompt", () => {
  beforeEach(() => {
    invalidatePersonalityCache();
    mockedExistsSync.mockReturnValue(false);
  });

  it("returns a string containing Kaya and Jm", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("Kaya");
    expect(prompt).toContain("Jm");
  });

  it("includes VOICE MODE RULES", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("VOICE MODE RULES");
  });

  it("does not include CURRENT CONTEXT when no contextSnippet", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).not.toContain("CURRENT CONTEXT");
  });

  it("includes CURRENT CONTEXT when contextSnippet is provided", () => {
    const snippet = "Active goal: Ship voice system\nToday: Tuesday";
    const prompt = buildVoiceSystemPrompt({ contextSnippet: snippet });
    expect(prompt).toContain("CURRENT CONTEXT:");
    expect(prompt).toContain("Active goal: Ship voice system");
    expect(prompt).toContain("Today: Tuesday");
  });

  it("uses identity overrides when provided", () => {
    const prompt = buildVoiceSystemPrompt({
      identity: {
        name: "TestBot",
        userName: "Alice",
      },
    });
    expect(prompt).toContain("TestBot");
    expect(prompt).toContain("Alice");
  });

  it("includes personality traits from DAIDENTITY.md when available", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `## Personality & Behavior\n- **Direct but Gentle** - Tell harsh truths with kindness\n- **Proactive** - Anticipate needs before asked\n---\n`
    );

    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("Direct but Gentle");
    expect(prompt).toContain("Proactive");
  });

  it("uses fallback personality when DAIDENTITY.md is missing", () => {
    mockedExistsSync.mockReturnValue(false);

    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("warm, efficient, and proactive");
  });

  it("includes voice rules about no markdown", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("Do NOT use markdown");
  });

  it("includes timezone reference instruction", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("timezone");
  });
});

describe("extractPersonalityTraits", () => {
  beforeEach(() => {
    invalidatePersonalityCache();
  });

  it("returns non-empty string", () => {
    mockedExistsSync.mockReturnValue(false);
    const traits = extractPersonalityTraits();
    expect(traits.length).toBeGreaterThan(0);
  });

  it("returns fallback when DAIDENTITY.md missing", () => {
    mockedExistsSync.mockReturnValue(false);
    const traits = extractPersonalityTraits();
    expect(traits).toContain("warm, efficient, and proactive");
  });

  it("extracts personality bullet points from DAIDENTITY.md", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `## Personality & Behavior\n` +
      `- **Direct but Gentle** - Tell harsh truths with kindness\n` +
      `- **Proactive** - Anticipate needs before asked\n` +
      `---\n`
    );

    const traits = extractPersonalityTraits();
    expect(traits).toContain("Direct but Gentle: Tell harsh truths with kindness");
    expect(traits).toContain("Proactive: Anticipate needs before asked");
  });

  it("extracts voice characteristics from DAIDENTITY.md", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `**Voice Characteristics:**\n` +
      `- Speaks with quiet confidence\n` +
      `- Occasional dry humor\n` +
      `**Other:**\n`
    );

    const traits = extractPersonalityTraits();
    expect(traits).toContain("Speaks with quiet confidence");
    expect(traits).toContain("Occasional dry humor");
  });

  it("extracts role from Assistant quote", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `**Assistant:** "The trusted advisor who tells you what you need to hear"\n`
    );

    const traits = extractPersonalityTraits();
    expect(traits).toContain("The trusted advisor who tells you what you need to hear");
  });
});

describe("getMinimalContext", () => {
  it("returns string with user name", () => {
    const ctx = getMinimalContext();
    expect(ctx).toContain("Jm");
  });

  it("returns string with timezone", () => {
    const ctx = getMinimalContext();
    expect(ctx).toContain("America/Los_Angeles");
  });

  it("uses identity overrides", () => {
    const ctx = getMinimalContext({ userName: "Alice", timezone: "Europe/London" });
    expect(ctx).toContain("Alice");
    expect(ctx).toContain("Europe/London");
  });

  it("returns a short string (under 200 chars)", () => {
    const ctx = getMinimalContext();
    expect(ctx.length).toBeLessThan(200);
  });
});

describe("personality caching", () => {
  beforeEach(() => {
    invalidatePersonalityCache();
    mockedExistsSync.mockClear();
    mockedReadFileSync.mockClear();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `## Personality & Behavior\n- **Kind** - Always gentle\n---\n`
    );
  });

  it("caches personality after first load", () => {
    extractPersonalityTraits();
    extractPersonalityTraits();

    // readFileSync should only be called once for DAIDENTITY path
    const daidentityCalls = mockedReadFileSync.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("DAIDENTITY")
    );
    expect(daidentityCalls.length).toBe(1);
  });

  it("invalidatePersonalityCache forces reload", () => {
    extractPersonalityTraits();
    invalidatePersonalityCache();
    extractPersonalityTraits();

    const daidentityCalls = mockedReadFileSync.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("DAIDENTITY")
    );
    expect(daidentityCalls.length).toBe(2);
  });
});
