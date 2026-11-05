/**
 * goldenIsc.ts — single location of the frozen golden ISC spec fixtures.
 *
 * The 25 JSON files in `lib/test/fixtures/golden-isc/` are FROZEN: never edit them.
 * Shared by skills/Automation/AutonomousWork (comprehension-merit-eval) and
 * skills/Development/Evals (build-isc-extraction-golden). Skills may import lib/.
 */
import { join } from "node:path";

export const GOLDEN_ISC_DIR = join(import.meta.dir, "golden-isc");
