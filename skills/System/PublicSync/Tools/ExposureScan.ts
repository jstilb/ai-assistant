#!/usr/bin/env bun
/**
 * ExposureScan.ts — offline core of the weekly mirror exposure scan (audit S-18).
 *
 * Given the file list of the public mirror and a way to read each file, report
 *   1. files that the blocklist allowlist would NOT publish today (drift), and
 *   2. secret, blocked-identifier or PII findings in the content of the files.
 *
 * Pure and dependency-injected: no network, no live paths. The caller (a cron
 * job) lists a clone of the mirror, calls this, and pages via AlertGate when
 * `clean` is false. Wiring that cron job is a follow-up (it needs the mirror clone).
 */

import { BlocklistFilter, SecretScanner, type BlocklistConfig } from "./SyncEngine.ts";

interface PiiPattern {
  name: string;
  regex: RegExp;
}

/** Owner-agnostic PII patterns: personal home paths and e-mail addresses. */
const DEFAULT_PII_PATTERNS: readonly PiiPattern[] = [
  { name: "home-path", regex: /\/Users\/[A-Za-z0-9._-]+\// },
  {
    name: "email-address",
    regex: /\b[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
];

interface ExposureFinding {
  path: string;
  kind: "secret" | "pii";
  pattern: string;
  line: number;
}

interface ExposureReport {
  /** Mirror files the current blocklist would not publish. */
  disallowed: string[];
  findings: ExposureFinding[];
  /** Files that could not be read (reported, never skipped silently). */
  unreadable: string[];
  filesScanned: number;
  clean: boolean;
}

interface ExposureScanInput {
  blocklist: BlocklistConfig;
  mirrorFiles: readonly string[];
  /** Return the file text, or null when it is binary or unreadable. */
  readFile: (relativePath: string) => string | null;
  piiPatterns?: readonly PiiPattern[];
}

export function scanMirrorExposure(input: ExposureScanInput): ExposureReport {
  const filter = new BlocklistFilter(input.blocklist);
  const scanner = new SecretScanner(input.blocklist.blockedIdentifiers ?? []);
  const pii = input.piiPatterns ?? DEFAULT_PII_PATTERNS;

  const disallowed: string[] = [];
  const unreadable: string[] = [];
  const findings: ExposureFinding[] = [];

  for (const path of input.mirrorFiles) {
    if (!filter.isAllowed(path)) disallowed.push(path);
    const text = input.readFile(path);
    if (text === null) {
      unreadable.push(path);
      continue;
    }
    for (const f of scanner.scan(text).findings) {
      findings.push({ path, kind: "secret", pattern: f.pattern, line: f.line });
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const p of pii) {
        if (p.regex.test(line)) findings.push({ path, kind: "pii", pattern: p.name, line: i + 1 });
      }
    }
  }

  return {
    disallowed: disallowed.sort(),
    findings,
    unreadable: unreadable.sort(),
    filesScanned: input.mirrorFiles.length,
    clean: disallowed.length === 0 && findings.length === 0,
  };
}
