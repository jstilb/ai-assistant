/**
 * InterestProfile.ts — Load and validate the user's EventScout interest profile.
 *
 * loadProfile(pathOverride?) → Promise<InterestProfile>
 *
 * Path resolution order:
 *   1. pathOverride argument (if provided)
 *   2. EVENTSCOUT_PROFILE_PATH environment variable
 *   3. Default: <skill-root>/InterestProfile.json
 *
 * Throws a descriptive error if the file is missing or fails Zod validation.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { InterestProfileSchema } from "./types.ts";
import type { InterestProfile } from "./types.ts";

// ============================================================================
// Path resolution
// ============================================================================

/**
 * The default InterestProfile.json path (next to this file's skill root).
 * The profile is user-editable config that lives in the skill root (not State/).
 */
const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROFILE_PATH = join(SKILL_ROOT, "InterestProfile.json");

/**
 * Resolve the profile path: override > env > default.
 */
function resolveProfilePath(pathOverride?: string): string {
  if (pathOverride) return pathOverride;
  const envPath = process.env["EVENTSCOUT_PROFILE_PATH"];
  if (envPath) return envPath;
  return DEFAULT_PROFILE_PATH;
}

// ============================================================================
// loadProfile
// ============================================================================

/**
 * Load and validate InterestProfile.json.
 *
 * @param pathOverride - Optional explicit path (for tests or custom configs).
 * @throws If the file cannot be read or fails schema validation.
 */
export async function loadProfile(pathOverride?: string): Promise<InterestProfile> {
  const profilePath = resolveProfilePath(pathOverride);

  let raw: unknown;
  try {
    const text = readFileSync(profilePath, "utf-8");
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[InterestProfile] Failed to read profile at "${profilePath}": ${(err as Error).message}`
    );
  }

  // Strip the _README field before validation (it's editorial metadata)
  if (raw !== null && typeof raw === "object") {
    const { _README: _dropped, ...rest } = raw as Record<string, unknown>;
    raw = rest;
    void _dropped;
  }

  const result = InterestProfileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[InterestProfile] Profile at "${profilePath}" failed validation:\n${result.error.message}`
    );
  }

  return result.data;
}
