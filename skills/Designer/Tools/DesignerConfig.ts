#!/usr/bin/env bun
/**
 * DesignerConfig.ts - Load Designer user preferences from YAML files
 *
 * Loads USER/style-preferences.yaml, USER/rooms.yaml, USER/design-goals.yaml
 * with sensible defaults when files are missing.
 *
 * Usage:
 *   import { loadDesignerConfig } from './DesignerConfig';
 *   const config = loadDesignerConfig();
 *
 * @module DesignerConfig
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DesignerConfig {
  aesthetic: {
    primary: string;
    secondary: string;
    descriptors: string[];
  };
  colors: {
    love: string[];
    avoid: string[];
    accentPreference: string;
  };
  budget: "budget" | "moderate" | "premium" | "luxury";
  avoidStyles: string[];
  rooms: RoomConfig[];
  goals: DesignGoal[];
}

export interface RoomConfig {
  name: string;
  dimensions?: string;
  naturalLight?: string;
  currentStyle?: string;
  photos?: string[];
}

export interface DesignGoal {
  name: string;
  priority?: "high" | "medium" | "low";
  deadline?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DesignerConfig = {
  aesthetic: {
    primary: "cozy",
    secondary: "warm",
    descriptors: ["lived-in", "warm", "inviting", "textured"],
  },
  colors: {
    love: ["warm neutrals", "earth tones"],
    avoid: ["neon", "stark white"],
    accentPreference: "pops of color",
  },
  budget: "moderate",
  avoidStyles: ["ultra-modern", "industrial", "sterile"],
  rooms: [],
  goals: [],
};

// ---------------------------------------------------------------------------
// YAML loading helpers
// ---------------------------------------------------------------------------

function loadYaml(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseYaml(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export function loadDesignerConfig(skillDir?: string): DesignerConfig {
  const baseDir = skillDir || join(process.env.HOME || "", ".claude/skills/Designer");
  const userDir = join(baseDir, "USER");

  // Start with defaults
  const config: DesignerConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Load style preferences
  const stylePref = loadYaml(join(userDir, "style-preferences.yaml"));
  if (stylePref) {
    const aesthetic = stylePref.aesthetic as Record<string, unknown> | undefined;
    if (aesthetic) {
      if (typeof aesthetic.primary === "string") config.aesthetic.primary = aesthetic.primary;
      if (typeof aesthetic.secondary === "string") config.aesthetic.secondary = aesthetic.secondary;
      if (Array.isArray(aesthetic.descriptors)) config.aesthetic.descriptors = asStringArray(aesthetic.descriptors);
    }

    const colors = stylePref.colors as Record<string, unknown> | undefined;
    if (colors) {
      config.colors.love = asStringArray(colors.love);
      config.colors.avoid = asStringArray(colors.avoid);
      if (typeof colors.accent_preference === "string") {
        config.colors.accentPreference = colors.accent_preference;
      }
    }

    if (typeof stylePref.budget === "string") {
      config.budget = stylePref.budget as DesignerConfig["budget"];
    }

    config.avoidStyles = asStringArray(stylePref.avoid_styles);
  }

  // Load rooms config
  const roomsData = loadYaml(join(userDir, "rooms.yaml"));
  if (roomsData && Array.isArray(roomsData.rooms)) {
    config.rooms = (roomsData.rooms as Record<string, unknown>[]).map((r) => ({
      name: String(r.name || ""),
      dimensions: r.dimensions ? String(r.dimensions) : undefined,
      naturalLight: r.natural_light ? String(r.natural_light) : undefined,
      currentStyle: r.current_style ? String(r.current_style) : undefined,
      photos: r.photos ? asStringArray(r.photos) : undefined,
    }));
  }

  // Load design goals
  const goalsData = loadYaml(join(userDir, "design-goals.yaml"));
  if (goalsData && Array.isArray(goalsData.goals)) {
    config.goals = (goalsData.goals as Record<string, unknown>[]).map((g) => ({
      name: String(g.name || ""),
      priority: g.priority ? String(g.priority) as DesignGoal["priority"] : undefined,
      deadline: g.deadline ? String(g.deadline) : undefined,
      notes: g.notes ? String(g.notes) : undefined,
    }));
  }

  return config;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = loadDesignerConfig();
  console.log(JSON.stringify(config, null, 2));
}
