#!/usr/bin/env bun
/**
 * Decision Framework Tool
 *
 * Playbook-based GREEN/YELLOW/RED traffic-light decision engine.
 * Reusable core tool that other Kaya skills can import for scoring
 * decisions across multiple domains (calendar, shopping, tasks, health).
 *
 * Usage:
 *   import { DecisionFramework, evaluate } from './DecisionFramework';
 *
 *   // Quick evaluation via singleton
 *   const result = evaluate('shopping', 'New headphones', { price: 89, budget: 100, rating: 4.5, inStock: true, hasRedFlags: false });
 *
 *   // Or instantiate for custom domains
 *   const fw = new DecisionFramework();
 *   fw.registerDomain('custom', [...rules]);
 *   const result = fw.evaluate('custom', 'My decision', { ... });
 *
 * CLI:
 *   bun DecisionFramework.ts --test
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type Signal = 'GREEN' | 'YELLOW' | 'RED';

export interface DecisionResult {
  signal: Signal;
  domain: string;
  label: string;
  reasons: string[];
  action: string;
}

export interface Rule {
  check: (input: Record<string, unknown>) => boolean;
  signal: Signal;
  reason: string;
  action: string;
}

// ── Built-in Domain Rules ──────────────────────────────────────────────────

const CALENDAR_RULES: Rule[] = [
  // RED rules first (most severe)
  {
    check: (i) => Boolean(i.isDoubleBooked),
    signal: 'RED',
    reason: 'Double-booked time slot',
    action: 'Decline or reschedule immediately',
  },
  {
    check: (i) => typeof i.hour === 'number' && i.hour < 8,
    signal: 'RED',
    reason: 'Before 8am — violates hard constraint',
    action: 'Decline and propose a later time',
  },
  {
    check: (i) => Boolean(i.hasConflict),
    signal: 'RED',
    reason: 'Time conflict with existing event',
    action: 'Resolve conflict before accepting',
  },
  // YELLOW rules
  {
    check: (i) => typeof i.hour === 'number' && (i.hour < 9 || i.hour >= 18),
    signal: 'YELLOW',
    reason: 'Outside preferred hours (9am-6pm)',
    action: 'Accept if important, otherwise suggest preferred window',
  },
  {
    check: (i) => Boolean(i.backToBack),
    signal: 'YELLOW',
    reason: 'Back-to-back meeting — no buffer',
    action: 'Accept but request 5-min buffer if possible',
  },
  // GREEN rule
  {
    check: (i) =>
      !i.hasConflict &&
      !i.isDoubleBooked &&
      typeof i.hour === 'number' &&
      i.hour >= 9 &&
      i.hour < 18,
    signal: 'GREEN',
    reason: 'No conflicts, within preferred hours',
    action: 'Accept — looks good',
  },
];

const SHOPPING_RULES: Rule[] = [
  // RED rules first
  {
    check: (i) =>
      typeof i.price === 'number' &&
      typeof i.budget === 'number' &&
      i.price > i.budget * 1.2,
    signal: 'RED',
    reason: 'Over budget by more than 20%',
    action: 'Skip — find a cheaper alternative',
  },
  {
    check: (i) => typeof i.rating === 'number' && i.rating < 3.5,
    signal: 'RED',
    reason: 'Rating below 3.5 — poor quality signal',
    action: 'Skip — not worth the risk',
  },
  {
    check: (i) => Boolean(i.hasRedFlags),
    signal: 'RED',
    reason: 'Major red flags detected',
    action: 'Do not purchase — investigate concerns',
  },
  {
    check: (i) => !i.inStock,
    signal: 'RED',
    reason: 'Out of stock',
    action: 'Set alert for restock or find alternative',
  },
  // YELLOW rules
  {
    check: (i) =>
      typeof i.price === 'number' &&
      typeof i.budget === 'number' &&
      i.price > i.budget &&
      i.price <= i.budget * 1.2,
    signal: 'YELLOW',
    reason: 'Slightly over budget (within 20%)',
    action: 'Consider if the value justifies the extra cost',
  },
  {
    check: (i) =>
      typeof i.rating === 'number' && i.rating >= 3.5 && i.rating < 4.0,
    signal: 'YELLOW',
    reason: 'Rating 3.5-3.9 — mixed reviews',
    action: 'Read recent reviews before deciding',
  },
  // GREEN rule
  {
    check: (i) =>
      typeof i.price === 'number' &&
      typeof i.budget === 'number' &&
      i.price <= i.budget &&
      typeof i.rating === 'number' &&
      i.rating >= 4.0 &&
      Boolean(i.inStock) &&
      !i.hasRedFlags,
    signal: 'GREEN',
    reason: 'Within budget, highly rated, in stock',
    action: 'Buy — solid choice',
  },
];

const TASK_RULES: Rule[] = [
  // RED rules first
  {
    check: (i) => !i.isWIGAligned && !i.hasMissionAlignment && i.daysUntilDeadline === null,
    signal: 'RED',
    reason: 'No mission alignment and no deadline',
    action: 'Deprioritize or remove from list',
  },
  // GREEN rules (check before YELLOW since they are more specific)
  {
    check: (i) => Boolean(i.isOverdue),
    signal: 'GREEN',
    reason: 'Task is overdue — needs immediate attention',
    action: 'Do this now — it is past due',
  },
  {
    check: (i) => Boolean(i.isWIGAligned),
    signal: 'GREEN',
    reason: 'Aligned with a WIG (Q1 goal)',
    action: 'Prioritize — this moves the needle',
  },
  {
    check: (i) =>
      typeof i.daysUntilDeadline === 'number' && i.daysUntilDeadline <= 3,
    signal: 'GREEN',
    reason: 'Deadline within 3 days',
    action: 'Execute now — deadline approaching',
  },
  // YELLOW rules
  {
    check: (i) =>
      !i.isWIGAligned &&
      Boolean(i.hasMissionAlignment) &&
      (i.daysUntilDeadline === null || (typeof i.daysUntilDeadline === 'number' && i.daysUntilDeadline > 3)),
    signal: 'YELLOW',
    reason: 'Nice-to-have — loosely aligned, no deadline pressure',
    action: 'Schedule for later or batch with similar tasks',
  },
];

const HEALTH_RULES: Rule[] = [
  // RED rules first
  {
    check: (i) => typeof i.consecutiveSkipDays === 'number' && i.consecutiveSkipDays >= 3,
    signal: 'RED',
    reason: 'Skipped 3+ consecutive days',
    action: 'Resume today — even a short session counts',
  },
  // YELLOW rules
  {
    check: (i) =>
      !i.completedToday &&
      typeof i.consecutiveSkipDays === 'number' &&
      i.consecutiveSkipDays >= 1 &&
      i.consecutiveSkipDays < 3,
    signal: 'YELLOW',
    reason: 'Partial completion or skipped 1 day',
    action: 'Get back on track today',
  },
  {
    check: (i) => !i.completedToday && (typeof i.consecutiveSkipDays !== 'number' || i.consecutiveSkipDays === 0),
    signal: 'YELLOW',
    reason: 'Not completed today yet',
    action: 'Complete your session before end of day',
  },
  // GREEN rule
  {
    check: (i) => Boolean(i.completedToday),
    signal: 'GREEN',
    reason: 'Exercise/PT completed today',
    action: 'Great work — maintain the streak',
  },
];

// ── Decision Framework Class ───────────────────────────────────────────────

export class DecisionFramework {
  private domains: Map<string, Rule[]>;

  constructor() {
    this.domains = new Map();

    // Register built-in domains
    this.domains.set('calendar', CALENDAR_RULES);
    this.domains.set('shopping', SHOPPING_RULES);
    this.domains.set('task', TASK_RULES);
    this.domains.set('health', HEALTH_RULES);
  }

  /**
   * Register rules for a domain. Overwrites existing rules if domain already exists.
   */
  registerDomain(name: string, rules: Rule[]): void {
    this.domains.set(name, rules);
  }

  /**
   * Evaluate input against domain rules.
   * Rules are checked in definition order (RED first, then YELLOW, then GREEN).
   * First matching rule wins.
   */
  evaluate(domain: string, label: string, input: Record<string, unknown>): DecisionResult {
    const rules = this.domains.get(domain);

    if (!rules) {
      return {
        signal: 'YELLOW',
        domain,
        label,
        reasons: [`Unknown domain: "${domain}"`],
        action: 'Register this domain before evaluating',
      };
    }

    // Collect all matching rules
    const matches: { rule: Rule; signal: Signal }[] = [];
    for (const rule of rules) {
      try {
        if (rule.check(input)) {
          matches.push({ rule, signal: rule.signal });
        }
      } catch {
        // Skip rules that throw on unexpected input shapes
      }
    }

    if (matches.length === 0) {
      return {
        signal: 'YELLOW',
        domain,
        label,
        reasons: ['Insufficient data for assessment'],
        action: 'Provide more information to evaluate',
      };
    }

    // Sort by severity: RED > YELLOW > GREEN
    const severityOrder: Record<Signal, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
    matches.sort((a, b) => severityOrder[a.signal] - severityOrder[b.signal]);

    // First match (most severe) wins
    const winner = matches[0];

    // Collect all reasons from matching rules at the same or worse severity
    const reasons = matches
      .filter((m) => severityOrder[m.signal] <= severityOrder[winner.signal])
      .map((m) => m.rule.reason);

    return {
      signal: winner.signal,
      domain,
      label,
      reasons,
      action: winner.rule.action,
    };
  }

  /**
   * Return emoji badge for a signal.
   */
  static badge(signal: Signal): string {
    return signal === 'GREEN' ? '\uD83D\uDFE2' : signal === 'YELLOW' ? '\uD83D\uDFE1' : '\uD83D\uDD34';
  }

  /**
   * Format a DecisionResult as a single markdown line.
   */
  static formatLine(result: DecisionResult): string {
    return `${DecisionFramework.badge(result.signal)} **${result.label}**: ${result.reasons[0]} \u2192 _${result.action}_`;
  }
}

// ── Singleton convenience function ─────────────────────────────────────────

let _singleton: DecisionFramework | null = null;

function getSingleton(): DecisionFramework {
  if (!_singleton) {
    _singleton = new DecisionFramework();
  }
  return _singleton;
}

/**
 * Convenience function: evaluate using the shared singleton instance.
 */
export function evaluate(
  domain: string,
  label: string,
  input: Record<string, unknown>,
): DecisionResult {
  return getSingleton().evaluate(domain, label, input);
}

// ── CLI Entry Point ────────────────────────────────────────────────────────

function runTests(): void {
  const fw = new DecisionFramework();

  console.log('Decision Framework — Test Suite');
  console.log('='.repeat(60));
  console.log('');

  // Calendar tests
  console.log('CALENDAR DOMAIN');
  console.log('-'.repeat(40));

  const cal1 = fw.evaluate('calendar', '10am Team Standup', {
    hour: 10,
    hasConflict: false,
    backToBack: false,
    isDoubleBooked: false,
  });
  console.log(DecisionFramework.formatLine(cal1));

  const cal2 = fw.evaluate('calendar', '7am Early Call', {
    hour: 7,
    hasConflict: false,
    backToBack: false,
    isDoubleBooked: false,
  });
  console.log(DecisionFramework.formatLine(cal2));

  const cal3 = fw.evaluate('calendar', '3pm Double-booked', {
    hour: 15,
    hasConflict: true,
    backToBack: true,
    isDoubleBooked: true,
  });
  console.log(DecisionFramework.formatLine(cal3));

  const cal4 = fw.evaluate('calendar', '7pm Evening Call', {
    hour: 19,
    hasConflict: false,
    backToBack: false,
    isDoubleBooked: false,
  });
  console.log(DecisionFramework.formatLine(cal4));

  console.log('');

  // Shopping tests
  console.log('SHOPPING DOMAIN');
  console.log('-'.repeat(40));

  const shop1 = fw.evaluate('shopping', 'Sony WH-1000XM5', {
    price: 279,
    budget: 300,
    rating: 4.7,
    inStock: true,
    hasRedFlags: false,
  });
  console.log(DecisionFramework.formatLine(shop1));

  const shop2 = fw.evaluate('shopping', 'Cheap Knockoff Earbuds', {
    price: 15,
    budget: 50,
    rating: 2.8,
    inStock: true,
    hasRedFlags: true,
  });
  console.log(DecisionFramework.formatLine(shop2));

  const shop3 = fw.evaluate('shopping', 'Mid-range Speaker', {
    price: 110,
    budget: 100,
    rating: 3.7,
    inStock: true,
    hasRedFlags: false,
  });
  console.log(DecisionFramework.formatLine(shop3));

  console.log('');

  // Task tests
  console.log('TASK PRIORITIZATION DOMAIN');
  console.log('-'.repeat(40));

  const task1 = fw.evaluate('task', 'Ship Q1 auth feature', {
    isWIGAligned: true,
    hasMissionAlignment: true,
    daysUntilDeadline: 2,
    isOverdue: false,
  });
  console.log(DecisionFramework.formatLine(task1));

  const task2 = fw.evaluate('task', 'Refactor old CSS', {
    isWIGAligned: false,
    hasMissionAlignment: true,
    daysUntilDeadline: null,
    isOverdue: false,
  });
  console.log(DecisionFramework.formatLine(task2));

  const task3 = fw.evaluate('task', 'Learn Rust for fun', {
    isWIGAligned: false,
    hasMissionAlignment: false,
    daysUntilDeadline: null,
    isOverdue: false,
  });
  console.log(DecisionFramework.formatLine(task3));

  console.log('');

  // Health tests
  console.log('HEALTH/REHAB DOMAIN');
  console.log('-'.repeat(40));

  const health1 = fw.evaluate('health', 'PT Exercises', {
    completedToday: true,
    consecutiveSkipDays: 0,
  });
  console.log(DecisionFramework.formatLine(health1));

  const health2 = fw.evaluate('health', 'Morning Stretch', {
    completedToday: false,
    consecutiveSkipDays: 1,
  });
  console.log(DecisionFramework.formatLine(health2));

  const health3 = fw.evaluate('health', 'Knee Rehab', {
    completedToday: false,
    consecutiveSkipDays: 5,
  });
  console.log(DecisionFramework.formatLine(health3));

  console.log('');

  // Unknown domain test
  console.log('EDGE CASES');
  console.log('-'.repeat(40));

  const unknown = fw.evaluate('finance', 'Test unknown domain', { amount: 100 });
  console.log(DecisionFramework.formatLine(unknown));

  const empty = fw.evaluate('calendar', 'Empty input', {});
  console.log(DecisionFramework.formatLine(empty));

  console.log('');
  console.log('='.repeat(60));
  console.log('All test evaluations complete.');
}

// Run tests when invoked with --test flag
if (process.argv.includes('--test')) {
  runTests();
}
