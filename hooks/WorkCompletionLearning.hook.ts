#!/usr/bin/env bun
/**
 * WorkCompletionLearning.hook.ts - Extract Learnings from Completed Work (SessionEnd)
 *
 * PURPOSE:
 * Bridges the WORK/ system to the LEARNING/ system. When a session ends with
 * significant work completed, this hook captures the work metadata (files changed,
 * tools used, ideal state criteria) and creates a learning file for future reference.
 * This ensures insights compound over time rather than being lost.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/current-work.json, MEMORY/WORK/<dir>/META.yaml, MEMORY/WORK/audit.jsonl
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Creates: MEMORY/LEARNING/<category>/<YYYY-MM>/<datetime>_work_<slug>.md
 * - Reads: Current work state and work directory metadata
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: AutoWorkCreation (expects WORK/ structure)
 * - COORDINATES WITH: SessionSummary (both run at SessionEnd)
 * - MUST RUN BEFORE: SessionSummary (captures before state is cleared)
 * - MUST RUN AFTER: Stop handlers (captures completed work)
 *
 * SIGNIFICANT WORK CRITERIA:
 * A learning is only captured if:
 * - Files were changed, OR
 * - Multiple items exist in work directory, OR
 * - Work was manually created (source: MANUAL), OR
 * - Audit entries exist with non-trivial verdicts (FAIL, NEEDS_REVIEW, or multi-tier)
 *
 * LEARNING CATEGORIES:
 * - ALGORITHM: Insights about process/approach improvement
 * - SYSTEM: Technical system improvements
 * (Determined by getLearningCategory utility)
 *
 * ERROR HANDLING:
 * - No active work: Silent exit
 * - Missing META.yaml: Silent exit
 * - Write failures: Logged to stderr, silent exit
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (fire-and-forget at session end)
 * - Typical execution: <100ms
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getISOTimestamp, getPSTDate } from './lib/time';
import { getLearningCategory } from './lib/learning-utils';

const MEMORY_DIR = join(process.env.HOME!, '.claude', 'MEMORY');
const STATE_DIR = join(MEMORY_DIR, 'STATE');
const CURRENT_WORK_FILE = join(STATE_DIR, 'current-work.json');
const WORK_DIR = join(MEMORY_DIR, 'WORK');
const AUDIT_PATH = join(WORK_DIR, 'audit.jsonl');
const LEARNING_DIR = join(MEMORY_DIR, 'LEARNING');

interface CurrentWork {
  session_id: string;
  work_dir: string;
  created_at: string;
  item_count: number;
}

interface AuditEntry {
  timestamp: string;
  itemId: string;
  itemTitle: string;
  verdict: string;
  concerns: string[];
  tiersExecuted: number[];
  verificationCost: number;
  iscRowSummary: string[];
  failureReason?: string;
  adversarialConcerns?: string[];
}

interface WorkMeta {
  id: string;
  title: string;
  created_at: string;
  completed_at: string | null;
  source: string;
  status: string;
  session_id: string;
  lineage: {
    tools_used: string[];
    files_changed: string[];
    agents_spawned: string[];
  };
}

function parseYaml(content: string): WorkMeta {
  // Simple YAML parser for our specific format
  const meta: any = {};
  const lines = content.split('\n');
  let currentKey = '';
  let inArray = false;
  let arrayKey = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle array items
    if (trimmed.startsWith('- ') && inArray) {
      const value = trimmed.slice(2).replace(/^["']|["']$/g, '');
      if (arrayKey === 'lineage') {
        // Nested array in lineage
        const lastKey = Object.keys(meta.lineage).pop();
        if (lastKey) meta.lineage[lastKey].push(value);
      } else {
        meta[arrayKey].push(value);
      }
      continue;
    }

    // Handle key: value pairs
    const match = trimmed.match(/^([a-z_]+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      currentKey = key;

      if (key === 'lineage') {
        meta.lineage = { tools_used: [], files_changed: [], agents_spawned: [] };
        inArray = false;
        continue;
      }

      if (value === '[]') {
        if (meta.lineage) {
          meta.lineage[key] = [];
        } else {
          meta[key] = [];
        }
        inArray = false;
      } else if (value === '') {
        if (meta.lineage && ['tools_used', 'files_changed', 'agents_spawned'].includes(key)) {
          meta.lineage[key] = [];
          arrayKey = 'lineage';
          inArray = true;
        } else {
          meta[key] = [];
          arrayKey = key;
          inArray = true;
        }
      } else {
        const cleanValue = value.replace(/^["']|["']$/g, '');
        if (meta.lineage && ['tools_used', 'files_changed', 'agents_spawned'].includes(key)) {
          meta.lineage[key] = cleanValue === 'null' ? [] : [cleanValue];
        } else {
          meta[key] = cleanValue === 'null' ? null : cleanValue;
        }
        inArray = false;
      }
    }
  }

  return meta as WorkMeta;
}

function readAuditEntries(sessionCreatedAt: string): AuditEntry[] {
  if (!existsSync(AUDIT_PATH)) return [];
  try {
    const raw = readFileSync(AUDIT_PATH, 'utf-8');
    const lines = raw.trim().split('\n');
    // Read last 200 lines max
    const tail = lines.slice(-200);
    const sessionStart = new Date(sessionCreatedAt).getTime();
    const now = Date.now();
    const entries: AuditEntry[] = [];
    for (const line of tail) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        const ts = new Date(entry.timestamp).getTime();
        if (ts >= sessionStart && ts <= now) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function formatVerificationTable(entries: AuditEntry[]): string {
  if (entries.length === 0) return '';
  const rows = entries.map(e => {
    const tiers = e.tiersExecuted.length > 0 ? e.tiersExecuted.join(',') : '-';
    const concerns = e.concerns.length > 0 ? e.concerns.slice(0, 2).join('; ') : '-';
    return `| ${e.itemTitle.slice(0, 30)} | ${e.verdict} | ${tiers} | $${e.verificationCost.toFixed(2)} | ${concerns} |`;
  });
  return `| Item | Verdict | Tiers | Cost | Concerns |
|------|---------|-------|------|----------|
${rows.join('\n')}`;
}

function formatPatternSignals(entries: AuditEntry[]): string {
  if (entries.length === 0) return '';
  const total = entries.length;
  const passed = entries.filter(e => e.verdict === 'PASS').length;
  const failed = entries.filter(e => e.verdict === 'FAIL').length;
  const needsReview = entries.filter(e => e.verdict === 'NEEDS_REVIEW').length;
  const totalCost = entries.reduce((sum, e) => sum + e.verificationCost, 0);
  const avgCost = totalCost / total;

  // Top concern categories
  const allConcerns = entries.flatMap(e => e.concerns);
  const concernCounts = new Map<string, number>();
  for (const c of allConcerns) {
    const key = c.slice(0, 50);
    concernCounts.set(key, (concernCounts.get(key) || 0) + 1);
  }
  const topConcerns = [...concernCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([concern, count]) => `  - ${concern} (${count}x)`);

  return `- **Pass Rate:** ${passed}/${total} (${Math.round(passed / total * 100)}%)
- **Failed:** ${failed} | **Needs Review:** ${needsReview}
- **Total Verification Cost:** $${totalCost.toFixed(2)} (avg $${avgCost.toFixed(2)}/item)
${topConcerns.length > 0 ? `- **Top Concerns:**\n${topConcerns.join('\n')}` : ''}`;
}

function getMonthDir(category: 'SYSTEM' | 'ALGORITHM'): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const monthDir = join(LEARNING_DIR, category, `${year}-${month}`);

  if (!existsSync(monthDir)) {
    mkdirSync(monthDir, { recursive: true });
  }

  return monthDir;
}

function writeLearning(workMeta: WorkMeta, idealContent: string, auditEntries: AuditEntry[] = []): void {
  const category = getLearningCategory(workMeta.title);
  const monthDir = getMonthDir(category);

  const dateStr = getPSTDate();
  const timeStr = new Date().toISOString().split('T')[1].slice(0, 5).replace(':', '');
  const titleSlug = workMeta.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30);

  const filename = `${dateStr}_${timeStr}_work_${titleSlug}.md`;
  const filepath = join(monthDir, filename);

  // Don't overwrite existing learnings
  if (existsSync(filepath)) {
    console.error(`[WorkCompletionLearning] Learning already exists: ${filename}`);
    return;
  }

  // Calculate session duration
  let duration = 'Unknown';
  if (workMeta.created_at && workMeta.completed_at) {
    const start = new Date(workMeta.created_at);
    const end = new Date(workMeta.completed_at);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes < 60) {
      duration = `${minutes} minutes`;
    } else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      duration = `${hours}h ${mins}m`;
    }
  }

  // Build audit sections conditionally
  let verificationSection = '';
  let adversarialSection = '';
  let iscOutcomesSection = '';
  let patternSection = '';

  if (auditEntries.length > 0) {
    const table = formatVerificationTable(auditEntries);
    if (table) {
      verificationSection = `\n## Verification Outcomes\n\n${table}\n`;
    }

    // Deduplicated adversarial concerns across all entries
    const allAdversarial = [...new Set(auditEntries.flatMap(e => e.adversarialConcerns || []))];
    if (allAdversarial.length > 0) {
      adversarialSection = `\n## Adversarial Concerns\n\n${allAdversarial.map(c => `- ${c}`).join('\n')}\n`;
    }

    // Aggregated ISC row outcomes
    const allIscRows = auditEntries.flatMap(e => e.iscRowSummary);
    if (allIscRows.length > 0) {
      const statusCounts = new Map<string, number>();
      for (const row of allIscRows) {
        const status = row.split(':')[1] || 'UNKNOWN';
        statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      }
      const statusLines = [...statusCounts.entries()].map(([s, c]) => `- ${s}: ${c}`);
      iscOutcomesSection = `\n## ISC Row Outcomes\n\n${statusLines.join('\n')}\n`;
    }

    const signals = formatPatternSignals(auditEntries);
    if (signals) {
      patternSection = `\n## Pattern Signals\n\n${signals}\n`;
    }
  }

  const content = `# Work Completion Learning

**Title:** ${workMeta.title}
**Duration:** ${duration}
**Category:** ${category}
**Session:** ${workMeta.session_id}

---

## Ideal State Criteria

${idealContent || 'Not specified'}

## What Was Done

- **Files Changed:** ${workMeta.lineage?.files_changed?.length || 0}
- **Tools Used:** ${workMeta.lineage?.tools_used?.join(', ') || 'None tracked'}
- **Agents Spawned:** ${workMeta.lineage?.agents_spawned?.length || 0}
${verificationSection}${adversarialSection}${iscOutcomesSection}${patternSection}
## Insights

*This work session completed successfully. Consider what made it effective:*

- Was the approach straightforward or did it require iteration?
- Were there any blockers or surprises?
- What patterns from this work apply to future tasks?

---

*Auto-captured by WorkCompletionLearning hook at session end*
`;

  writeFileSync(filepath, content);
  console.error(`[WorkCompletionLearning] Created learning: ${filename}`);
}

async function main() {
  try {
    // Read input from stdin (required for hook pattern)
    const input = await Bun.stdin.text();
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    // Check if there's an active work session
    if (!existsSync(CURRENT_WORK_FILE)) {
      console.error('[WorkCompletionLearning] No active work session');
      process.exit(0);
    }

    // Read current work state
    const currentWork: CurrentWork = JSON.parse(readFileSync(CURRENT_WORK_FILE, 'utf-8'));

    if (!currentWork.work_dir) {
      console.error('[WorkCompletionLearning] No work directory in current session');
      process.exit(0);
    }

    // Read work directory metadata
    const workPath = join(WORK_DIR, currentWork.work_dir);
    const metaPath = join(workPath, 'META.yaml');

    if (!existsSync(metaPath)) {
      console.error('[WorkCompletionLearning] No META.yaml found');
      process.exit(0);
    }

    const metaContent = readFileSync(metaPath, 'utf-8');
    const workMeta = parseYaml(metaContent);

    // Update completed_at if not set
    if (!workMeta.completed_at) {
      workMeta.completed_at = getISOTimestamp();
    }

    // Read ISC.json if it exists
    const iscPath = join(workPath, 'ISC.json');
    let idealContent = '';
    if (existsSync(iscPath)) {
      try {
        const iscData = JSON.parse(readFileSync(iscPath, 'utf-8'));
        // Format ISC for human-readable learning
        if (iscData.current?.criteria?.length > 0) {
          idealContent = '**Criteria:**\n' + iscData.current.criteria.map((c: string) => `- ${c}`).join('\n');
        }
        if (iscData.current?.antiCriteria?.length > 0) {
          idealContent += '\n\n**Anti-Criteria:**\n' + iscData.current.antiCriteria.map((c: string) => `- ${c}`).join('\n');
        }
        if (iscData.satisfaction) {
          const s = iscData.satisfaction;
          idealContent += `\n\n**Satisfaction:** ${s.satisfied}/${s.total} satisfied, ${s.partial} partial, ${s.failed} failed`;
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Read audit entries for this session
    const auditEntries = readAuditEntries(currentWork.created_at);

    // Check if this was significant work (has files changed, was manually created, or has non-trivial audit entries)
    const hasNonTrivialAudit = auditEntries.some(e => e.verdict !== 'PASS' || e.tiersExecuted.length > 1);
    const hasSignificantWork = (
      (workMeta.lineage?.files_changed?.length || 0) > 0 ||
      currentWork.item_count > 1 ||
      workMeta.source === 'MANUAL' ||
      hasNonTrivialAudit
    );

    if (hasSignificantWork) {
      writeLearning(workMeta, idealContent, auditEntries);
    } else {
      console.error('[WorkCompletionLearning] Trivial work session, skipping learning capture');
    }

    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[WorkCompletionLearning] Error: ${error}`);
    process.exit(0);
  }
}

main();
