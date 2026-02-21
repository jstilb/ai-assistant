#!/usr/bin/env bun
/**
 * TextInferenceFallback.ts - Last-resort room analysis from filename patterns
 *
 * Extracts room type from image filename patterns and returns a best-guess
 * RoomAnalysis with hardcoded confidence < 0.5. This always returns a valid
 * result, making it the guaranteed fallback in the 3-tier chain.
 *
 * Usage:
 *   import { analyzeWithTextInference } from './TextInferenceFallback';
 *   const analysis = await analyzeWithTextInference('/path/to/living-room.jpg');
 *
 * @module TextInferenceFallback
 */

import { basename } from "path";

// ---------------------------------------------------------------------------
// Types (shared interface)
// ---------------------------------------------------------------------------

export interface RoomAnalysis {
  room_type: string;
  styles: string[];
  dominant_colors: Array<{ name: string; hex: string }>;
  lighting: string;
  features: string[];
  confidence: number;
  source: "claude" | "gemini" | "text_inference";
}

// ---------------------------------------------------------------------------
// Room type extraction from filename
// ---------------------------------------------------------------------------

interface RoomPattern {
  pattern: RegExp;
  roomType: string;
}

const ROOM_PATTERNS: RoomPattern[] = [
  { pattern: /living[\s_-]?room/i, roomType: "living room" },
  { pattern: /dining[\s_-]?room/i, roomType: "dining room" },
  { pattern: /bed[\s_-]?room/i, roomType: "bedroom" },
  { pattern: /bath[\s_-]?room/i, roomType: "bathroom" },
  { pattern: /kitchen/i, roomType: "kitchen" },
  { pattern: /office/i, roomType: "office" },
  { pattern: /nursery/i, roomType: "nursery" },
  { pattern: /studio/i, roomType: "studio" },
  { pattern: /den/i, roomType: "den" },
  { pattern: /laundry/i, roomType: "laundry" },
  { pattern: /garage/i, roomType: "garage" },
  { pattern: /patio/i, roomType: "patio" },
  { pattern: /balcony/i, roomType: "balcony" },
  { pattern: /foyer|entryway|entry/i, roomType: "entryway" },
  { pattern: /hallway|hall/i, roomType: "hallway" },
  { pattern: /closet/i, roomType: "closet" },
  { pattern: /basement/i, roomType: "basement" },
  { pattern: /attic/i, roomType: "attic" },
];

export function extractRoomTypeFromFilename(filePath: string): string {
  const filename = basename(filePath).toLowerCase();

  for (const { pattern, roomType } of ROOM_PATTERNS) {
    if (pattern.test(filename)) {
      return roomType;
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Default data by room type
// ---------------------------------------------------------------------------

interface RoomDefaults {
  styles: string[];
  colors: Array<{ name: string; hex: string }>;
  lighting: string;
  features: string[];
}

const ROOM_DEFAULTS: Record<string, RoomDefaults> = {
  "living room": {
    styles: ["contemporary", "comfortable"],
    colors: [
      { name: "warm beige", hex: "#F5F5DC" },
      { name: "soft gray", hex: "#D3D3D3" },
    ],
    lighting: "mixed natural and artificial lighting",
    features: ["seating area", "entertainment center"],
  },
  bedroom: {
    styles: ["cozy", "restful"],
    colors: [
      { name: "soft white", hex: "#FAF9F6" },
      { name: "light blue", hex: "#ADD8E6" },
    ],
    lighting: "soft ambient lighting",
    features: ["bed", "nightstands"],
  },
  kitchen: {
    styles: ["functional", "modern"],
    colors: [
      { name: "white", hex: "#FFFFFF" },
      { name: "stainless", hex: "#C0C0C0" },
    ],
    lighting: "bright task lighting",
    features: ["countertops", "appliances", "cabinets"],
  },
  bathroom: {
    styles: ["clean", "minimal"],
    colors: [
      { name: "white", hex: "#FFFFFF" },
      { name: "tile gray", hex: "#A9A9A9" },
    ],
    lighting: "bright vanity lighting",
    features: ["vanity", "mirror", "fixtures"],
  },
  "dining room": {
    styles: ["elegant", "social"],
    colors: [
      { name: "warm wood", hex: "#DEB887" },
      { name: "cream", hex: "#FFFDD0" },
    ],
    lighting: "ambient overhead lighting",
    features: ["dining table", "chairs"],
  },
  office: {
    styles: ["productive", "organized"],
    colors: [
      { name: "neutral gray", hex: "#808080" },
      { name: "white", hex: "#FFFFFF" },
    ],
    lighting: "bright desk lighting",
    features: ["desk", "chair", "shelving"],
  },
};

const UNKNOWN_DEFAULTS: RoomDefaults = {
  styles: ["general"],
  colors: [
    { name: "neutral", hex: "#C0C0C0" },
    { name: "white", hex: "#FFFFFF" },
  ],
  lighting: "standard lighting",
  features: ["furniture"],
};

// ---------------------------------------------------------------------------
// Main analysis function (always succeeds)
// ---------------------------------------------------------------------------

export async function analyzeWithTextInference(
  imagePath: string,
  _focus?: string,
): Promise<RoomAnalysis> {
  const roomType = extractRoomTypeFromFilename(imagePath);
  const defaults = ROOM_DEFAULTS[roomType] || UNKNOWN_DEFAULTS;

  // Confidence: higher for recognized room types, lower for unknown
  const isKnown = roomType !== "unknown";
  const confidence = isKnown ? 0.35 : 0.15;

  console.error(
    `[TextInferenceFallback] Filename-based analysis: room_type=${roomType}, confidence=${confidence}`,
  );

  return {
    room_type: roomType,
    styles: defaults.styles,
    dominant_colors: defaults.colors,
    lighting: defaults.lighting,
    features: defaults.features,
    confidence,
    source: "text_inference",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.log("Usage: bun TextInferenceFallback.ts <image-path>");
    process.exit(0);
  }

  const result = await analyzeWithTextInference(imagePath);
  console.log(JSON.stringify(result, null, 2));
}
