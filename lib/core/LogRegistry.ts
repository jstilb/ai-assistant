/**
 * LogRegistry — Static registry of all Kaya log locations with metadata.
 *
 * Purpose: Single source of truth for log file discovery. AgentMonitor,
 * the Observability unified dashboard, and MonitorCore `logs` command all
 * use this registry to enumerate log files without hardcoding paths.
 *
 * To register a new log file: add an entry to LOG_REGISTRY.
 * Fields:
 *   id          — unique stable key for programmatic lookup
 *   path        — path relative to KAYA_HOME (default: ~/.claude), or glob pattern
 *   format      — file format variant
 *   description — human-readable purpose
 *   retention   — retention policy string (informational; enforcement is in MemoryCleanup.ts)
 */

export type LogFormat =
  | "jsonl-appended"    // single JSONL file, lines appended over time
  | "jsonl-daily"       // one JSONL file per day (YYYY-MM-DD.jsonl)
  | "jsonl-per-workflow" // one JSONL file per workflow/session
  | "jsonl-per-event"   // one JSONL file per event (e.g. security events)
  | "json-daily"        // one JSON file per day
  | "text-daily";       // plain text, one file per day

export interface LogRegistryEntry {
  /** Unique stable identifier for programmatic lookup */
  id: string;
  /**
   * Path relative to KAYA_HOME, or a glob pattern.
   * Examples:
   *   "MEMORY/MONITORING/audit/alerts.jsonl"
   *   "MEMORY/MONITORING/traces/"
   *   "MEMORY/SECURITY/"
   */
  path: string;
  format: LogFormat;
  description: string;
  /** Retention policy (informational). Enforcement is in MemoryCleanup.ts JSONL_REGISTRY. */
  retention: string;
  /** Which skill or subsystem owns this log */
  owner?: string;
}

export const LOG_REGISTRY: readonly LogRegistryEntry[] = [
  // ── Agent monitoring traces ──────────────────────────────────────────────
  {
    id: "monitoring-traces",
    path: "MEMORY/MONITORING/traces/",
    format: "jsonl-per-workflow",
    description: "Agent execution traces (AgentMonitor)",
    retention: "90d",
    owner: "System/AgentMonitor",
  },
  // ── Unified event sink (P1-ObservabilityConvergence) ────────────────────
  {
    id: "unified-events",
    path: "MEMORY/MONITORING/events/",
    format: "jsonl-daily",
    description: "All Kaya events via UnifiedEventSink",
    retention: "90d",
    owner: "lib/core/UnifiedEventSink",
  },
  // ── Hook execution timing ─────────────────────────────────────────────
  {
    id: "hook-metrics",
    path: "MEMORY/MONITORING/hook-metrics.jsonl",
    format: "jsonl-appended",
    description: "Hook execution timing",
    retention: "30d",
    owner: "hooks",
  },
  // ── Security events ───────────────────────────────────────────────────
  {
    id: "security-events",
    path: "MEMORY/SECURITY/",
    format: "jsonl-per-event",
    description: "Security blocks, confirmations, alerts",
    retention: "365d",
    owner: "hooks/SecurityValidator",
  },
  // ── Anomaly alerts ────────────────────────────────────────────────────
  {
    id: "alerts",
    path: "MEMORY/MONITORING/audit/alerts.jsonl",
    format: "jsonl-appended",
    description: "AgentMonitor anomaly alerts",
    retention: "indefinite",
    owner: "System/AgentMonitor",
  },
  // ── SecurityValidator allow-tally ────────────────────────────────────
  {
    id: "allow-tally",
    path: "MEMORY/MONITORING/allow-tally/",
    format: "json-daily",
    description: "SecurityValidator allow operation counts",
    retention: "90d",
    owner: "hooks/SecurityValidator",
  },
  // ── Hook health log ───────────────────────────────────────────────────
  {
    id: "hook-health",
    path: "MEMORY/MONITORING/hook-health.jsonl",
    format: "jsonl-appended",
    description: "Persistent hook failure log",
    retention: "90d",
    owner: "hooks",
  },
  // ── AutoMaintenance errors ────────────────────────────────────────────
  {
    id: "auto-maintenance-errors",
    path: "MEMORY/AutoMaintenance/errors.jsonl",
    format: "jsonl-appended",
    description: "AutoMaintenance error log",
    retention: "90d",
    owner: "Automation/AutoMaintenance",
  },
  // ── Work transition audit ─────────────────────────────────────────────
  {
    id: "work-transition-audit",
    path: "MEMORY/WORK/transition-audit.jsonl",
    format: "jsonl-appended",
    description: "AutonomousWork state transition audit",
    retention: "90d",
    owner: "Automation/AutonomousWork",
  },
  // ── Monitor audit ─────────────────────────────────────────────────────
  {
    id: "monitor-audit",
    path: "MEMORY/MONITORING/audit/monitor-audit.jsonl",
    format: "jsonl-appended",
    description: "AgentMonitor audit log",
    retention: "60d",
    owner: "System/AgentMonitor",
  },
  // ── BrightData scrape audit (BrightData skill — P2 arch review) ──────
  {
    id: "brightdata-scrapes",
    path: "MEMORY/MONITORING/audit/brightdata-scrapes.jsonl",
    format: "jsonl-appended",
    description: "BrightData scrape attempts — tier used, success/failure, duration, credit usage",
    retention: "90d",
    owner: "Data/BrightData",
  },
] as const;

/**
 * Find a log registry entry by its stable ID.
 * Returns undefined if not found.
 */
export function findLog(id: string): LogRegistryEntry | undefined {
  return LOG_REGISTRY.find((entry) => entry.id === id);
}

/**
 * List all registered log entries.
 */
export function listLogs(): readonly LogRegistryEntry[] {
  return LOG_REGISTRY;
}

/**
 * Find all log entries owned by a given skill or subsystem.
 * Matches on partial owner string (case-insensitive).
 */
export function findLogsByOwner(owner: string): LogRegistryEntry[] {
  const lower = owner.toLowerCase();
  return LOG_REGISTRY.filter((e) => e.owner?.toLowerCase().includes(lower));
}
