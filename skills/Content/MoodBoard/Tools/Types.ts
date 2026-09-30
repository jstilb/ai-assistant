/**
 * Types.ts - Shared types and zod schemas for the MoodBoard skill
 *
 * A "board" is a named collection of "pins" (images with provenance) around a
 * theme — fashion, interior design, travel, tattoo ideas, anything visual.
 * Boards persist via StateManager; rendered collages live in ~/.kaya/moodboards/.
 *
 * @module MoodBoard/Types
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Where a pinned image came from. "manual" = pasted URL (e.g. from Pinterest). */
export const PIN_SOURCES = ["openverse", "wikimedia", "met", "manual"] as const;
export type PinSource = (typeof PIN_SOURCES)[number];

// ---------------------------------------------------------------------------
// Image candidates (search results, not yet pinned)
// ---------------------------------------------------------------------------

export const ImageCandidateSchema = z.object({
  /** Full-size (or largest available) image URL */
  imageUrl: z.string().min(1),
  /** Smaller display URL for collage rendering; falls back to imageUrl */
  thumbUrl: z.string().optional(),
  /** Human landing page for attribution (Flickr page, Commons file page, Met object page) */
  pageUrl: z.string().optional(),
  title: z.string().default(""),
  source: z.enum(PIN_SOURCES),
  creator: z.string().optional(),
  /** License short name, e.g. "CC BY-NC-ND 2.0", "Public Domain" */
  license: z.string().optional(),
  /** The search query that surfaced this candidate */
  query: z.string().optional(),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

// ---------------------------------------------------------------------------
// Pins and boards
// ---------------------------------------------------------------------------

export const PinSchema = ImageCandidateSchema.extend({
  /** Deterministic short hash of imageUrl — stable dedupe key */
  id: z.string().min(1),
  /** Freeform annotation ("love the collar shape") */
  note: z.string().optional(),
  addedAt: z.string(),
});
export type Pin = z.infer<typeof PinSchema>;

export const BoardSchema = z.object({
  /** URL-safe identifier, unique across boards */
  slug: z.string().min(1),
  title: z.string().min(1),
  /** One-line creative direction, shown on the rendered collage */
  theme: z.string().default(""),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  pins: z.array(PinSchema).default([]),
});
export type Board = z.infer<typeof BoardSchema>;

export const BoardsStateSchema = z.object({
  version: z.literal(1),
  boards: z.array(BoardSchema),
});
export type BoardsState = z.infer<typeof BoardsStateSchema>;

export function defaultBoardsState(): BoardsState {
  return { version: 1, boards: [] };
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export interface SourceResult {
  source: PinSource;
  ok: boolean;
  error?: string;
  candidates: ImageCandidate[];
}
