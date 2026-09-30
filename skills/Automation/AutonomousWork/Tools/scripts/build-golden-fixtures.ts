/**
 * build-golden-fixtures.ts — golden-fixture TYPE definitions.
 *
 * The original fixture BUILDER (which ran the now-deleted regex SpecParser over a
 * curated spec set to produce ground-truth JSON) is RETIRED: parity-against-the-old-
 * parser was replaced by the merit-based eval (comprehension-merit-eval.ts). The 25
 * fixture JSONs in __tests__/fixtures/golden-isc/ remain as a diverse real-spec
 * corpus the merit eval runs comprehension against. Only the shared types live here.
 */

export interface GoldenISCRow {
  number: number;
  description: string;
  verifyMethod?: string;
  embeddedCommand?: string;
  source?: string;
  disposition?: "human-required" | "automatable";
  isChecked?: boolean;
  priority?: "smoke" | "full";
}

export interface GoldenFixture {
  specPath: string;
  layoutNote: string;
  rowCount: number;
  rows: GoldenISCRow[];
  generatedAt: string;
}
