/**
 * Centralized Path Resolution — Backward-compatible shim.
 *
 * Re-exports from lib/core/KayaHome.ts using legacy names (getKayaDir, kayaPath)
 * for backward compatibility. New non-hook code must import getKayaHome() directly
 * from lib/core/KayaHome.ts.
 *
 * Usage:
 *   import { getKayaDir, kayaPath } from './lib/paths';
 *   const kayaDir = getKayaDir(); // Always returns expanded absolute path
 */

import { join } from "node:path";
export { getKayaHome as getKayaDir, kayaHomePath as kayaPath, expandPath } from "../../lib/core/KayaHome.ts";
import { getKayaHome } from "../../lib/core/KayaHome.ts";

/**
 * Get the settings.json path
 */
export function getSettingsPath(): string {
  return join(getKayaHome(), "settings.json");
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  return join(getKayaHome(), "MEMORY");
}
