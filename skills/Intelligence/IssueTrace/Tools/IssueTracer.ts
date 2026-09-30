#!/usr/bin/env bun
/**
 * IssueTracer — Graph-based development / issue tracing
 *
 * Records development issues (bugs, errors, blockers, regressions) into the
 * shared Kaya knowledge graph and traces their full lifecycle:
 *
 *     cause(s) ──caused──▶ issue ──fixed_by──▶ commit
 *                            │
 *                            ├──blocks──▶ (blocked by)
 *                            └──learned_from──▶ learning (resolution)
 *
 * This activates the graph's dormant `issue` / `caused` / `fixed_by` / `blocks`
 * / `learned_from` schema (defined in Graph/types.ts but with 0 nodes in
 * production) so that issues become first-class, traceable graph citizens that
 * the IssueLearningBridge can mine and feed into AgentMetacognition.
 *
 * Design — append-only friendly:
 *   The graph store is append-only and dedups by id, so issue lifecycle status
 *   is NEVER mutated in place. Instead, status is *derived* from incident edges
 *   at trace time:
 *     - resolved  → has an outgoing fixed_by OR learned_from edge
 *     - blocked   → not resolved AND has an incoming blocks edge
 *     - open      → otherwise
 *   This keeps every write a pure append and makes the history auditable.
 *
 * Usage (library):
 *   import { IssueTracer } from "./IssueTracer";
 *   const t = new IssueTracer();
 *   const id = t.openIssue({ title: "queue list ignores positional arg", severity: "high", file: "skills/.../CLI.ts" });
 *   t.resolveIssue(id, { commit: "abc1234", resolution: "honor positional queue arg" });
 *   const trace = t.traceIssue(id);
 *
 * Usage (CLI):
 *   bun IssueTracer.ts open --title "..." --severity high --file path --cause error:xyz
 *   bun IssueTracer.ts resolve <issueId> --commit abc1234 --resolution "..." --learning "..."
 *   bun IssueTracer.ts block <issueId> --by issue:other
 *   bun IssueTracer.ts cause <issueId> --cause error:xyz
 *   bun IssueTracer.ts trace <issueId> [--json]
 *   bun IssueTracer.ts list [--status open|resolved|blocked] [--severity high] [--file path] [--since 7d] [--json]
 *
 * @module IssueTrace/IssueTracer
 * @version 1.0.0
 */

import { parseArgs } from 'util';
// cross-skill-allowed: IssueTrace persists issue/trace nodes into the knowledge graph by design
import { GraphPersistence, getGraphPersistence } from '../../Graph/Tools/GraphPersistence';
// cross-skill-allowed: graph node/edge constructors + types for the writes above
import { createNode, createEdge, type GraphNode, type GraphNodeType } from '../../Graph/Tools/types';

// ============================================
// TYPES
// ============================================

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'resolved' | 'blocked';

export interface OpenIssueInput {
  /** Human-readable issue title (required) */
  title: string;
  /** Severity classification (default: 'medium') */
  severity?: IssueSeverity;
  /** Longer description / repro steps */
  description?: string;
  /** Primary file the issue lives in (e.g., "skills/Foo/Bar.ts") */
  file?: string;
  /** Logical component/area (e.g., "queue", "integrator") */
  component?: string;
  /** Session id this issue surfaced in — creates a session→issue `contains` edge */
  session?: string;
  /** Cause node ids (e.g., "error:abc", "commit:def", "file:path") — each gets a `caused` edge */
  causes?: string[];
  /** Extra tags */
  tags?: string[];
  /** Explicit id override (default: derived from title) */
  id?: string;
}

export interface ResolveIssueInput {
  /** Commit short/long hash that fixed it — creates issue→commit `fixed_by` edge */
  commit?: string;
  /** Short resolution summary (recorded on the resolution learning node) */
  resolution: string;
  /** Optional reusable learning/insight text — recorded as the learning node body */
  learning?: string;
}

export interface IssueTrace {
  issue: GraphNode;
  status: IssueStatus;
  severity: IssueSeverity;
  openedAt: string;
  resolvedAt: string | null;
  /** Wall-clock ms from open to resolution, null while open */
  timeToResolveMs: number | null;
  causes: GraphNode[];
  blockers: GraphNode[];
  fixes: GraphNode[];
  learnings: GraphNode[];
  /** Chronological event list for display */
  timeline: Array<{ at: string; event: string; node: string }>;
}

export interface ListFilter {
  status?: IssueStatus;
  severity?: IssueSeverity;
  file?: string;
  /** ISO date or relative "7d"/"24h" */
  since?: string;
  limit?: number;
}

const RESOLUTION_LEARNING_TAG = 'issue-resolution';
const LIFECYCLE_EDGE_TYPES = ['caused', 'blocks', 'fixed_by', 'learned_from', 'contains'] as const;

// ============================================
// ISSUE TRACER
// ============================================

export class IssueTracer {
  private persistence: GraphPersistence;

  constructor(persistence?: GraphPersistence) {
    this.persistence = persistence || getGraphPersistence();
  }

  /**
   * Record a new development issue in the graph.
   * @returns the issue node id
   */
  openIssue(input: OpenIssueInput): string {
    if (!input.title || !input.title.trim()) {
      throw new Error('openIssue: title is required');
    }
    const severity = input.severity ?? 'medium';
    const id = input.id ?? `issue:${slugify(input.title)}-${shortToken()}`;
    const now = new Date().toISOString();

    const tags = ['issue', `severity:${severity}`];
    if (input.component) tags.push(`component:${input.component}`);
    for (const t of input.tags ?? []) if (!tags.includes(t)) tags.push(t);

    const node = createNode('issue', id, input.title.trim(), {
      severity,
      status: 'open', // snapshot at open time; live status is derived from edges
      description: input.description ?? '',
      file: input.file ?? null,
      component: input.component ?? null,
      openedAt: now,
    }, tags);

    this.persistence.appendNode(node);

    // session → issue (contains)
    if (input.session) {
      const sessionId = input.session.startsWith('session:') ? input.session : `session:${input.session}`;
      this.ensureNode(sessionId, 'Session ' + input.session);
      this.persistence.appendEdge(
        createEdge('contains', sessionId, id, 1.0, { via: 'issue-trace' }),
      );
    }

    // file → issue (caused), if a file was named but not passed as an explicit cause
    const causes = [...(input.causes ?? [])];
    if (input.file) {
      const fileId = input.file.startsWith('file:') ? input.file : `file:${input.file}`;
      if (!causes.includes(fileId)) causes.push(fileId);
    }
    for (const causeId of causes) {
      this.linkCause(id, causeId);
    }

    return id;
  }

  /**
   * Link a cause (error / commit / file / other node) to an issue via a `caused` edge.
   * Creates a stub node for the cause if it does not yet exist.
   */
  linkCause(issueId: string, causeId: string, weight = 0.9): void {
    this.ensureNode(causeId, causeId);
    this.persistence.appendEdge(
      createEdge('caused', causeId, issueId, weight, { via: 'issue-trace' }),
    );
  }

  /**
   * Mark an issue as blocked by another node (issue / external) via a `blocks` edge.
   */
  blockIssue(issueId: string, blockerId: string): void {
    this.ensureNode(blockerId, blockerId);
    this.persistence.appendEdge(
      createEdge('blocks', blockerId, issueId, 1.0, { via: 'issue-trace' }),
    );
  }

  /**
   * Resolve an issue. Always records a resolution learning node (issue→learned_from→learning),
   * and additionally a fixed_by edge to the resolving commit when one is provided.
   * @returns the learning node id created for the resolution
   */
  resolveIssue(issueId: string, input: ResolveIssueInput): string {
    const issue = this.persistence.loadNodes('issue').find(n => n.id === issueId);
    if (!issue) throw new Error(`resolveIssue: unknown issue ${issueId}`);
    if (!input.resolution || !input.resolution.trim()) {
      throw new Error('resolveIssue: resolution is required');
    }

    const now = new Date().toISOString();
    const openedAt = (issue.metadata.openedAt as string) || issue.created_at;
    const timeToResolveMs = Math.max(0, new Date(now).getTime() - new Date(openedAt).getTime());

    // Resolution learning node — marks the issue resolved and is mineable by the bridge.
    const learningId = `learning:resolution:${issueId.replace(/^issue:/, '')}-${shortToken()}`;
    const learningBody = input.learning?.trim() || input.resolution.trim();
    const learning = createNode('learning', learningId, `Resolution: ${issue.title}`.slice(0, 120), {
      content: learningBody,
      resolution: input.resolution.trim(),
      resolvedAt: now,
      timeToResolveMs,
      issueId,
      commit: input.commit ?? null,
    }, ['learning', RESOLUTION_LEARNING_TAG, ...(issue.metadata.severity ? [`severity:${issue.metadata.severity}`] : [])]);
    this.persistence.appendNode(learning);
    this.persistence.appendEdge(
      createEdge('learned_from', issueId, learningId, 1.0, { via: 'issue-trace', resolvedAt: now }),
    );

    // fixed_by → commit, when supplied
    if (input.commit) {
      const commitId = input.commit.startsWith('commit:') ? input.commit : `commit:${input.commit}`;
      this.ensureNode(commitId, `Commit ${input.commit}`);
      this.persistence.appendEdge(
        createEdge('fixed_by', issueId, commitId, 1.0, {
          via: 'issue-trace',
          resolution: input.resolution.trim(),
          resolvedAt: now,
          timeToResolveMs,
        }),
      );
    }

    return learningId;
  }

  /**
   * Produce the full lifecycle trace for an issue, with derived status & timing.
   */
  traceIssue(issueId: string): IssueTrace {
    const engine = this.persistence.loadIntoEngine();
    const issue = engine.getNode(issueId);
    if (!issue || issue.type !== 'issue') {
      throw new Error(`traceIssue: unknown issue ${issueId}`);
    }

    const incident = this.incidentEdges(engine, issueId);
    const causes = incident
      .filter(e => e.type === 'caused' && e.target === issueId)
      .map(e => engine.getNode(e.source))
      .filter((n): n is GraphNode => !!n);
    const blockers = incident
      .filter(e => e.type === 'blocks' && e.target === issueId)
      .map(e => engine.getNode(e.source))
      .filter((n): n is GraphNode => !!n);
    const fixes = incident
      .filter(e => e.type === 'fixed_by' && e.source === issueId)
      .map(e => engine.getNode(e.target))
      .filter((n): n is GraphNode => !!n);
    const learnings = incident
      .filter(e => e.type === 'learned_from' && e.source === issueId)
      .map(e => engine.getNode(e.target))
      .filter((n): n is GraphNode => !!n);

    const resolved = fixes.length > 0 || learnings.length > 0;
    const status: IssueStatus = resolved ? 'resolved' : blockers.length > 0 ? 'blocked' : 'open';

    const openedAt = (issue.metadata.openedAt as string) || issue.created_at;
    let resolvedAt: string | null = null;
    if (resolved) {
      const resTimes = [
        ...learnings.map(l => l.metadata.resolvedAt as string | undefined),
        ...fixes.map(f => f.created_at),
      ].filter((t): t is string => !!t);
      resolvedAt = resTimes.sort()[0] ?? null;
    }
    const timeToResolveMs =
      resolvedAt ? Math.max(0, new Date(resolvedAt).getTime() - new Date(openedAt).getTime()) : null;

    const timeline: IssueTrace['timeline'] = [
      { at: openedAt, event: 'opened', node: issue.id },
      ...causes.map(c => ({ at: c.created_at, event: 'caused by', node: c.id })),
      ...blockers.map(b => ({ at: b.created_at, event: 'blocked by', node: b.id })),
      ...fixes.map(f => ({ at: f.created_at, event: 'fixed by', node: f.id })),
      ...learnings.map(l => ({ at: (l.metadata.resolvedAt as string) || l.created_at, event: 'learned', node: l.id })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    return {
      issue,
      status,
      severity: (issue.metadata.severity as IssueSeverity) ?? 'medium',
      openedAt,
      resolvedAt,
      timeToResolveMs,
      causes,
      blockers,
      fixes,
      learnings,
      timeline,
    };
  }

  /**
   * List issues with derived status, newest first.
   */
  listIssues(filter: ListFilter = {}): IssueTrace[] {
    const issues = this.persistence.loadNodes('issue');
    const sinceDate = filter.since ? parseSince(filter.since) : undefined;

    let traces = issues
      .map(i => this.traceIssue(i.id))
      .filter(t => {
        if (filter.status && t.status !== filter.status) return false;
        if (filter.severity && t.severity !== filter.severity) return false;
        if (filter.file && (t.issue.metadata.file as string | null) !== filter.file) return false;
        if (sinceDate && new Date(t.openedAt) < sinceDate) return false;
        return true;
      })
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

    if (filter.limit && filter.limit > 0) traces = traces.slice(0, filter.limit);
    return traces;
  }

  // ============================================
  // INTERNALS
  // ============================================

  /** Collect all lifecycle edges incident to a node id. */
  private incidentEdges(engine: ReturnType<GraphPersistence['loadIntoEngine']>, nodeId: string) {
    const out = [];
    for (const type of LIFECYCLE_EDGE_TYPES) {
      for (const e of engine.getEdges(type)) {
        if (e.source === nodeId || e.target === nodeId) out.push(e);
      }
    }
    return out;
  }

  /**
   * Ensure a referenced node exists; create a minimal stub if absent.
   * Node type is inferred from the id prefix ("file:..." → file).
   */
  private ensureNode(id: string, title: string): void {
    const type = inferNodeType(id);
    const existing = this.persistence.loadNodes(type).some(n => n.id === id);
    if (existing) return;
    this.persistence.appendNode(
      createNode(type, id, title.slice(0, 120), { stub: true, via: 'issue-trace' }, [type]),
    );
  }
}

// ============================================
// HELPERS
// ============================================

const KNOWN_PREFIXES: GraphNodeType[] = [
  'session', 'agent_trace', 'error', 'commit', 'learning',
  'skill_change', 'file', 'issue', 'decision', 'outcome', 'context',
];

function inferNodeType(id: string): GraphNodeType {
  const prefix = id.split(':')[0] as GraphNodeType;
  return KNOWN_PREFIXES.includes(prefix) ? prefix : 'context';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'issue';
}

let _counter = 0;
function shortToken(): string {
  // Monotonic-ish unique suffix; runtime (not workflow script) so Date.now is allowed.
  _counter = (_counter + 1) % 1000;
  return Date.now().toString(36).slice(-5) + _counter.toString(36);
}

function parseSince(since: string): Date {
  const rel = since.match(/^(\d+)\s*([dh])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const ms = rel[2].toLowerCase() === 'd' ? n * 86400000 : n * 3600000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(since);
  if (isNaN(d.getTime())) throw new Error(`Invalid --since: ${since}`);
  return d;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

  const printTrace = (t: IssueTrace) => {
    console.log(`\n${statusIcon(t.status)} ${t.issue.id}  [${t.severity}]  ${t.status}`);
    console.log(`   ${t.issue.title}`);
    if (t.issue.metadata.file) console.log(`   file: ${t.issue.metadata.file}`);
    console.log(`   opened: ${t.openedAt}  ttr: ${fmtDuration(t.timeToResolveMs)}`);
    for (const ev of t.timeline) console.log(`   • ${ev.at}  ${ev.event}  ${ev.node}`);
  };

  try {
    if (sub === 'open') {
      const { values } = parseArgs({
        args: rest,
        options: {
          title: { type: 'string' }, severity: { type: 'string' }, description: { type: 'string' },
          file: { type: 'string' }, component: { type: 'string' }, session: { type: 'string' },
          cause: { type: 'string', multiple: true }, tag: { type: 'string', multiple: true },
        },
      });
      if (!values.title) throw new Error('--title required');
      const tracer = new IssueTracer();
      const id = tracer.openIssue({
        title: values.title,
        severity: values.severity as IssueSeverity | undefined,
        description: values.description,
        file: values.file,
        component: values.component,
        session: values.session,
        causes: values.cause as string[] | undefined,
        tags: values.tag as string[] | undefined,
      });
      console.log(`Opened ${id}`);
    } else if (sub === 'resolve') {
      const issueId = rest[0];
      const { values } = parseArgs({
        args: rest.slice(1),
        options: { commit: { type: 'string' }, resolution: { type: 'string' }, learning: { type: 'string' } },
      });
      if (!issueId || !values.resolution) throw new Error('usage: resolve <issueId> --resolution "..." [--commit hash] [--learning "..."]');
      const tracer = new IssueTracer();
      const lid = tracer.resolveIssue(issueId, { commit: values.commit, resolution: values.resolution, learning: values.learning });
      console.log(`Resolved ${issueId} (learning ${lid})`);
    } else if (sub === 'cause') {
      const issueId = rest[0];
      const { values } = parseArgs({ args: rest.slice(1), options: { cause: { type: 'string', multiple: true } } });
      if (!issueId || !values.cause) throw new Error('usage: cause <issueId> --cause <nodeId>');
      const tracer = new IssueTracer();
      for (const c of values.cause as string[]) tracer.linkCause(issueId, c);
      console.log(`Linked ${(values.cause as string[]).length} cause(s) to ${issueId}`);
    } else if (sub === 'block') {
      const issueId = rest[0];
      const { values } = parseArgs({ args: rest.slice(1), options: { by: { type: 'string' } } });
      if (!issueId || !values.by) throw new Error('usage: block <issueId> --by <nodeId>');
      new IssueTracer().blockIssue(issueId, values.by);
      console.log(`${issueId} blocked by ${values.by}`);
    } else if (sub === 'trace') {
      const issueId = rest[0];
      const json = rest.includes('--json');
      if (!issueId) throw new Error('usage: trace <issueId>');
      const t = new IssueTracer().traceIssue(issueId);
      if (json) console.log(JSON.stringify(t, null, 2));
      else printTrace(t);
    } else if (sub === 'list') {
      const { values } = parseArgs({
        args: rest,
        options: {
          status: { type: 'string' }, severity: { type: 'string' }, file: { type: 'string' },
          since: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' },
        },
      });
      const traces = new IssueTracer().listIssues({
        status: values.status as IssueStatus | undefined,
        severity: values.severity as IssueSeverity | undefined,
        file: values.file,
        since: values.since,
        limit: values.limit ? parseInt(values.limit, 10) : undefined,
      });
      if (values.json) {
        console.log(JSON.stringify(traces, null, 2));
      } else {
        console.log(`\n${traces.length} issue(s)\n`);
        for (const t of traces) {
          console.log(`${statusIcon(t.status)} ${t.issue.id}  [${t.severity}]  ${t.status}  ttr:${fmtDuration(t.timeToResolveMs)}`);
          console.log(`   ${t.issue.title}`);
        }
      }
    } else {
      console.log(`IssueTracer — graph-based development / issue tracing

Commands:
  open    --title "..." [--severity low|medium|high|critical] [--file path] [--component name]
          [--session id] [--cause nodeId ...] [--tag t ...] [--description "..."]
  resolve <issueId> --resolution "..." [--commit hash] [--learning "..."]
  cause   <issueId> --cause <nodeId> [--cause <nodeId> ...]
  block   <issueId> --by <nodeId>
  trace   <issueId> [--json]
  list    [--status open|resolved|blocked] [--severity ...] [--file path] [--since 7d] [--limit N] [--json]
`);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function statusIcon(s: IssueStatus): string {
  return s === 'resolved' ? '✓' : s === 'blocked' ? '⛔' : '○';
}
