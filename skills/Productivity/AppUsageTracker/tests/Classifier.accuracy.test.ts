/**
 * Classifier.accuracy.test.ts — LLM-driven accuracy check vs synthetic fixture.
 *
 * Gated behind RUN_LLM_TESTS=1 so default `bun test` stays fast and free.
 *
 * IMPORTANT — invoke from outside ~/.claude:
 *   cd /tmp && RUN_LLM_TESTS=1 bun test \
 *     ~/.claude/skills/Productivity/AppUsageTracker/tests/Classifier.accuracy.test.ts
 *
 * The inference helper spawns `claude -p`. When bun test runs from inside
 * ~/.claude, claude detects the surrounding project (CLAUDE.md present) and
 * exits 1 silently — even if process.chdir is called. Production cron is
 * unaffected: launchd starts the classifier with WorkingDirectory unset.
 *
 * Last verified: 100% accuracy (10/10) on 2026-05-03.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySession, type Session } from "../Tools/Classifier.ts";

const RUN_LLM = process.env.RUN_LLM_TESTS === "1";

interface FixtureSession {
  device: string;
  app: string;
  duration_min: number;
  titles: string[];
  urls?: string[];
}

function buildSession(f: FixtureSession): Session {
  const startTs = new Date("2026-05-01T10:00:00Z");
  return {
    device: f.device,
    app: f.app,
    startTs,
    endTs: new Date(startTs.getTime() + f.duration_min * 60_000),
    totalDurationSec: f.duration_min * 60,
    events: f.titles.map((title, i) => ({
      id: `${f.device}:fixture:${i}`,
      device: f.device,
      app: f.app,
      title,
      url: f.urls?.[i] ?? null,
      ts_start: new Date(startTs.getTime() + i * 60_000),
      duration_sec: 60,
    })),
  };
}

test.skipIf(!RUN_LLM)("Classifier accuracy ≥80% on synthetic YouTube fixture", async () => {
  const fixturePath = join(import.meta.dir, "fixtures", "youtube-classification-fixtures.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    expected_low_value: FixtureSession[];
    expected_not_low_value: FixtureSession[];
  };

  const cases: Array<{ session: Session; want: boolean; firstTitle: string }> = [
    ...fixture.expected_low_value.map(f => ({ session: buildSession(f), want: true, firstTitle: f.titles[0] })),
    ...fixture.expected_not_low_value.map(f => ({ session: buildSession(f), want: false, firstTitle: f.titles[0] })),
  ];

  let correct = 0;
  const misclassified: string[] = [];
  for (const c of cases) {
    const result = await classifySession(c.session);
    if (result.verdict.is_low_value === c.want) {
      correct++;
    } else {
      misclassified.push(`  want=${c.want} got=${result.verdict.is_low_value} (${c.firstTitle})`);
    }
  }
  const accuracy = correct / cases.length;
  console.log(`Classifier accuracy: ${correct}/${cases.length} = ${(accuracy * 100).toFixed(1)}%`);
  if (misclassified.length > 0) console.log("Misclassified:\n" + misclassified.join("\n"));
  expect(accuracy).toBeGreaterThanOrEqual(0.8);
}, 300_000);
