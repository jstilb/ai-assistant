#!/usr/bin/env bun
/**
 * ActiveScanApproval.ts - Approval-gated active reconnaissance operations
 *
 * Integrates with CORE ApprovalQueue to require authorization before
 * performing active scanning operations (port scans, mass scans, etc.)
 *
 * Usage:
 *   # Request approval for a scan
 *   bun ActiveScanApproval.ts request --target 192.168.1.0/24 --scan-type port --ports 80,443
 *
 *   # Check approval status
 *   bun ActiveScanApproval.ts check <approval-id>
 *
 *   # Execute approved scan
 *   bun ActiveScanApproval.ts execute <approval-id>
 *
 *   # List pending approvals
 *   bun ActiveScanApproval.ts list
 *
 *   # Approve a scan (for authorized reviewers)
 *   bun ActiveScanApproval.ts approve <approval-id> --reviewer "admin" --notes "Authorized"
 *
 * @module ActiveScanApproval
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { z } from "zod";
import { createStateManager, type StateManager as StateManagerType } from "../../CORE/Tools/StateManager.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const RECON_APPROVAL_QUEUE_PATH = join(
  KAYA_HOME,
  "MEMORY/WORK/recon-approvals/queue.json"
);

/** Default expiry for scan approvals (7 days) */
const DEFAULT_EXPIRY_DAYS = 7;

// ============================================================================
// Types (inline to avoid import issues)
// ============================================================================

/** Status of an approval item */
type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** Priority level for queue ordering */
type Priority = "low" | "normal" | "high" | "critical";

/** Priority ordering for sorting */
const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Base fields for approval items */
interface ApprovalItemBase {
  id: string;
  status: ApprovalStatus;
  priority: Priority;
  createdAt: string;
  expiresAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNotes?: string;
}

/** Types of active scans that require approval */
export type ActiveScanType = "port" | "mass" | "service" | "banner" | "full";

/** Scan request data structure */
export interface ScanRequest {
  /** Target IP, CIDR, domain, or file path */
  target: string;
  /** Type of scan to perform */
  scanType: ActiveScanType;
  /** Ports to scan (e.g., "80,443" or "1-1000") */
  ports?: string;
  /** Authorization documentation (bug bounty URL, pentest SOW reference, etc.) */
  authorization?: string;
  /** Reason for the scan */
  reason?: string;
  /** Requested by (username or agent) */
  requestedBy?: string;
  /** Additional scan options as JSON string */
  optionsJson?: string;
}

/** Scan approval item (extends base with scan-specific data) */
export type ScanApprovalItem = ScanRequest & ApprovalItemBase;

/** Result of an approval check */
export interface ApprovalCheckResult {
  approved: boolean;
  approvalId?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "not_found";
  message: string;
  item?: ScanApprovalItem;
}

/** Port scan result structure */
interface PortScanResult {
  target: string;
  timestamp: string;
  scanType: string;
  portsScanned: string;
  totalHosts: number;
  totalPorts: number;
  results: Array<{
    host: string;
    ip: string;
    port: number;
    protocol: string;
    cdn?: string;
  }>;
  errors: string[];
}

/** Result of scan execution */
export interface ScanExecutionResult {
  success: boolean;
  approvalId: string;
  scanResult?: PortScanResult;
  error?: string;
}

// ============================================================================
// Queue State Management (StateManager-backed)
// ============================================================================

const QueueStateSchema = z.object({
  lastUpdated: z.string(),
  items: z.array(z.object({
    id: z.string(),
    status: z.enum(["pending", "approved", "rejected", "expired"]),
    priority: z.enum(["low", "normal", "high", "critical"]),
    createdAt: z.string(),
    expiresAt: z.string().optional(),
    reviewedAt: z.string().optional(),
    reviewedBy: z.string().optional(),
    reviewNotes: z.string().optional(),
    target: z.string(),
    scanType: z.enum(["port", "mass", "service", "banner", "full"]),
    ports: z.string().optional(),
    authorization: z.string().optional(),
    reason: z.string().optional(),
    requestedBy: z.string().optional(),
    optionsJson: z.string().optional(),
  })),
});

type QueueState = z.infer<typeof QueueStateSchema>;

const queueManager = createStateManager<QueueState>({
  path: RECON_APPROVAL_QUEUE_PATH,
  schema: QueueStateSchema,
  defaults: { lastUpdated: new Date().toISOString(), items: [] },
});

function loadQueueState(): QueueState {
  // Synchronous fallback for existing callers - load() is async but we need sync here.
  // Use the underlying file read since StateManager is async-only.
  if (!existsSync(RECON_APPROVAL_QUEUE_PATH)) {
    return { lastUpdated: new Date().toISOString(), items: [] };
  }
  try {
    const { readFileSync } = require("fs");
    const raw = readFileSync(RECON_APPROVAL_QUEUE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const result = QueueStateSchema.safeParse(parsed);
    return result.success ? result.data : { lastUpdated: new Date().toISOString(), items: [] };
  } catch {
    return { lastUpdated: new Date().toISOString(), items: [] };
  }
}

function saveQueueState(state: QueueState): void {
  const dir = join(RECON_APPROVAL_QUEUE_PATH, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  // Validate before writing
  const result = QueueStateSchema.safeParse(state);
  if (!result.success) {
    throw new Error(`Queue state validation failed: ${result.error.message}`);
  }
  const { writeFileSync } = require("fs");
  writeFileSync(RECON_APPROVAL_QUEUE_PATH, JSON.stringify(state, null, 2));
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function calculateExpiry(days: number = DEFAULT_EXPIRY_DAYS): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** Priority mapping based on scan type and target scope */
function getScanPriority(request: ScanRequest): Priority {
  // Mass scans and large CIDR ranges are high priority for review
  if (request.scanType === "mass") return "high";
  if (request.scanType === "full") return "high";

  // Check for large CIDR ranges
  if (request.target.includes("/")) {
    const cidrBits = parseInt(request.target.split("/")[1]);
    if (cidrBits < 24) return "high"; // /23 or larger
    if (cidrBits < 28) return "normal";
    return "low";
  }

  // Single host scans are lower priority
  return "normal";
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Request approval for an active scan operation
 */
export async function requestScanApproval(request: ScanRequest): Promise<string> {
  const state = loadQueueState();
  const priority = getScanPriority(request);
  const id = generateId();

  const item: ScanApprovalItem = {
    ...request,
    id,
    status: "pending",
    priority,
    createdAt: new Date().toISOString(),
    expiresAt: calculateExpiry(),
  };

  state.items.push(item);
  saveQueueState(state);

  console.log(`[ActiveScanApproval] New scan request queued: ${id}`);
  console.log(`  Target: ${request.target}`);
  console.log(`  Type: ${request.scanType}`);
  console.log(`  Priority: ${priority}`);

  return id;
}

/**
 * Check if a scan has been approved
 */
export async function checkScanApproval(
  approvalId: string
): Promise<ApprovalCheckResult> {
  const state = loadQueueState();
  const item = state.items.find((i) => i.id === approvalId);

  if (!item) {
    return {
      approved: false,
      status: "not_found",
      message: `Approval request not found: ${approvalId}`,
    };
  }

  // Check for expiry
  if (item.status === "pending" && item.expiresAt) {
    if (new Date(item.expiresAt) < new Date()) {
      item.status = "expired";
      saveQueueState(state);
    }
  }

  if (item.status === "approved") {
    return {
      approved: true,
      approvalId,
      status: "approved",
      message: "Scan approved - proceed with execution",
      item,
    };
  }

  if (item.status === "rejected") {
    return {
      approved: false,
      approvalId,
      status: "rejected",
      message: `Scan rejected: ${item.reviewNotes || "No reason provided"}`,
      item,
    };
  }

  if (item.status === "expired") {
    return {
      approved: false,
      approvalId,
      status: "expired",
      message: "Scan approval has expired - please submit a new request",
      item,
    };
  }

  return {
    approved: false,
    approvalId,
    status: "pending",
    message: "Scan approval is pending review",
    item,
  };
}

/**
 * Execute an approved scan using naabu directly
 */
export async function executeScan(
  approvalId: string
): Promise<ScanExecutionResult> {
  const check = await checkScanApproval(approvalId);

  if (!check.approved) {
    return {
      success: false,
      approvalId,
      error: check.message,
    };
  }

  const item = check.item!;

  try {
    // Build naabu command
    const args: string[] = ["naabu", "-host", item.target, "-json"];

    if (item.ports) {
      args.push("-p", item.ports);
    }

    console.log(`[ActiveScanApproval] Executing: ${args.join(" ")}`);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const result: PortScanResult = {
      target: item.target,
      timestamp: new Date().toISOString(),
      scanType: item.scanType,
      portsScanned: item.ports || "default",
      totalHosts: 0,
      totalPorts: 0,
      results: [],
      errors: [],
    };

    if (stderr) {
      const errors = stderr.split("\n").filter(
        (line) => line.includes("[ERR]") || line.includes("[FATAL]")
      );
      result.errors.push(...errors);
    }

    // Parse JSON lines output
    const lines = output.trim().split("\n").filter(Boolean);
    const hostSet = new Set<string>();

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.host && data.port) {
          result.results.push({
            host: data.host,
            ip: data.ip || data.host,
            port: data.port,
            protocol: data.protocol || "tcp",
            cdn: data.cdn,
          });
          hostSet.add(data.host);
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    result.totalHosts = hostSet.size;
    result.totalPorts = result.results.length;

    return {
      success: true,
      approvalId,
      scanResult: result,
    };
  } catch (error) {
    return {
      success: false,
      approvalId,
      error: `Scan execution failed: ${error}`,
    };
  }
}

/**
 * Approve a scan request
 */
export async function approveScan(
  approvalId: string,
  reviewer?: string,
  notes?: string
): Promise<ScanApprovalItem> {
  const state = loadQueueState();
  const item = state.items.find((i) => i.id === approvalId);

  if (!item) {
    throw new Error(`Item not found: ${approvalId}`);
  }

  if (item.status !== "pending") {
    throw new Error(`Item already ${item.status}: ${approvalId}`);
  }

  item.status = "approved";
  item.reviewedAt = new Date().toISOString();
  item.reviewNotes = notes;
  item.reviewedBy = reviewer;

  saveQueueState(state);

  console.log(`[ActiveScanApproval] Scan approved: ${approvalId}`);

  return item;
}

/**
 * Reject a scan request
 */
export async function rejectScan(
  approvalId: string,
  reviewer?: string,
  reason?: string
): Promise<ScanApprovalItem> {
  const state = loadQueueState();
  const item = state.items.find((i) => i.id === approvalId);

  if (!item) {
    throw new Error(`Item not found: ${approvalId}`);
  }

  if (item.status !== "pending") {
    throw new Error(`Item already ${item.status}: ${approvalId}`);
  }

  item.status = "rejected";
  item.reviewedAt = new Date().toISOString();
  item.reviewNotes = reason;
  item.reviewedBy = reviewer;

  saveQueueState(state);

  console.log(`[ActiveScanApproval] Scan rejected: ${approvalId}`);

  return item;
}

/**
 * List scan approvals with optional filter
 */
export async function listScans(
  filter?: { status?: ApprovalStatus }
): Promise<ScanApprovalItem[]> {
  const state = loadQueueState();
  let items = [...state.items];

  if (filter?.status) {
    items = items.filter((item) => item.status === filter.status);
  }

  // Sort by priority (descending)
  items.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);

  return items;
}

/**
 * Get approval queue statistics
 */
export async function getApprovalStats() {
  const state = loadQueueState();
  const stats = {
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    byPriority: {
      low: 0,
      normal: 0,
      high: 0,
      critical: 0,
    },
  };

  for (const item of state.items) {
    stats[item.status as keyof typeof stats]++;
    stats.byPriority[item.priority]++;
  }

  return stats;
}

/**
 * Helper: Request approval and check for existing approvals
 */
export async function requireApproval(
  request: ScanRequest
): Promise<ApprovalCheckResult> {
  const state = loadQueueState();

  // Look for an existing approval for the same target and scan type
  for (const item of state.items) {
    if (item.target === request.target && item.scanType === request.scanType) {
      if (item.status === "approved") {
        return {
          approved: true,
          approvalId: item.id,
          status: "approved",
          message: "Existing approval found for this target",
          item,
        };
      }
      if (item.status === "pending") {
        return {
          approved: false,
          approvalId: item.id,
          status: "pending",
          message: `Existing request pending approval: ${item.id}`,
          item,
        };
      }
    }
  }

  // No existing request - create one
  const approvalId = await requestScanApproval(request);

  return {
    approved: false,
    approvalId,
    status: "pending",
    message: `New scan approval requested: ${approvalId}. Awaiting authorization.`,
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function formatScanItem(item: ScanApprovalItem): string {
  const statusIndicator: Record<string, string> = {
    pending: "[PENDING]",
    approved: "[APPROVED]",
    rejected: "[REJECTED]",
    expired: "[EXPIRED]",
  };

  const priorityIndicator: Record<string, string> = {
    critical: "!!!",
    high: "!!",
    normal: "!",
    low: "",
  };

  const lines = [
    "---",
    `ID:            ${item.id}`,
    `Status:        ${statusIndicator[item.status]} ${item.status}`,
    `Priority:      ${priorityIndicator[item.priority]} ${item.priority}`,
    `Target:        ${item.target}`,
    `Scan Type:     ${item.scanType}`,
    `Ports:         ${item.ports || "default"}`,
    `Authorization: ${item.authorization || "None provided"}`,
    `Reason:        ${item.reason || "None provided"}`,
    `Requested By:  ${item.requestedBy || "Unknown"}`,
    `Created:       ${item.createdAt}`,
  ];

  if (item.expiresAt) {
    lines.push(`Expires:       ${item.expiresAt}`);
  }

  if (item.reviewedAt) {
    lines.push(`Reviewed:      ${item.reviewedAt}`);
  }

  if (item.reviewedBy) {
    lines.push(`Reviewer:      ${item.reviewedBy}`);
  }

  if (item.reviewNotes) {
    lines.push(`Notes:         ${item.reviewNotes}`);
  }

  lines.push("---");

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
ActiveScanApproval - Approval-gated active reconnaissance

Commands:
  request --target <target> --scan-type <type> [options]
      Request approval for an active scan

  check <approval-id>
      Check status of an approval request

  execute <approval-id>
      Execute an approved scan

  list [--status <status>]
      List approval requests

  approve <approval-id> [--reviewer <name>] [--notes <text>]
      Approve a scan request

  reject <approval-id> [--reviewer <name>] [--reason <text>]
      Reject a scan request

  stats
      Show approval queue statistics

Options for request:
  --target <target>       IP, CIDR, domain, or file
  --scan-type <type>      port | mass | service | banner | full
  --ports <ports>         Ports to scan (e.g., "80,443" or "1-1000")
  --authorization <text>  Authorization documentation
  --reason <text>         Reason for the scan
  --requested-by <name>   Who is requesting

Examples:
  # Request approval for a port scan
  bun ActiveScanApproval.ts request --target 192.168.1.0/24 --scan-type port --ports 80,443

  # Check approval status
  bun ActiveScanApproval.ts check 1234567890-abc123

  # Execute approved scan
  bun ActiveScanApproval.ts execute 1234567890-abc123

  # Approve a scan
  bun ActiveScanApproval.ts approve 1234567890-abc123 --reviewer admin

  # List pending scans
  bun ActiveScanApproval.ts list --status pending
`);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "request": {
      const targetIdx = args.indexOf("--target");
      const typeIdx = args.indexOf("--scan-type");
      const portsIdx = args.indexOf("--ports");
      const authIdx = args.indexOf("--authorization");
      const reasonIdx = args.indexOf("--reason");
      const requestedByIdx = args.indexOf("--requested-by");

      if (targetIdx === -1 || typeIdx === -1) {
        console.error("Error: --target and --scan-type are required");
        process.exit(1);
      }

      const request: ScanRequest = {
        target: args[targetIdx + 1],
        scanType: args[typeIdx + 1] as ActiveScanType,
        ports: portsIdx !== -1 ? args[portsIdx + 1] : undefined,
        authorization: authIdx !== -1 ? args[authIdx + 1] : undefined,
        reason: reasonIdx !== -1 ? args[reasonIdx + 1] : undefined,
        requestedBy: requestedByIdx !== -1 ? args[requestedByIdx + 1] : undefined,
      };

      const result = await requireApproval(request);
      console.log(`\nScan Approval Request`);
      console.log(`=====================`);
      console.log(`Status: ${result.status}`);
      console.log(`ID: ${result.approvalId}`);
      console.log(`Message: ${result.message}`);

      if (result.approved) {
        console.log(`\nScan is APPROVED - you may execute with:`);
        console.log(`  bun ActiveScanApproval.ts execute ${result.approvalId}`);
      } else {
        console.log(`\nScan requires approval. Check status with:`);
        console.log(`  bun ActiveScanApproval.ts check ${result.approvalId}`);
      }
      break;
    }

    case "check": {
      const approvalId = args[1];
      if (!approvalId) {
        console.error("Error: approval-id required");
        process.exit(1);
      }

      const result = await checkScanApproval(approvalId);
      console.log(`\nApproval Status: ${result.status.toUpperCase()}`);
      console.log(`Message: ${result.message}`);

      if (result.item) {
        console.log(`\n${formatScanItem(result.item)}`);
      }
      break;
    }

    case "execute": {
      const approvalId = args[1];
      if (!approvalId) {
        console.error("Error: approval-id required");
        process.exit(1);
      }

      console.log(`\nExecuting approved scan: ${approvalId}`);
      const result = await executeScan(approvalId);

      if (result.success) {
        console.log(`\nScan completed successfully!`);
        console.log(JSON.stringify(result.scanResult, null, 2));
      } else {
        console.error(`\nScan failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const statusIdx = args.indexOf("--status");
      const status = statusIdx !== -1 ? args[statusIdx + 1] : undefined;

      const filter = status ? { status: status as ApprovalStatus } : {};
      const items = await listScans(filter);

      if (items.length === 0) {
        console.log(`\nNo scan requests found.`);
      } else {
        console.log(`\nFound ${items.length} scan request(s):\n`);
        for (const item of items) {
          console.log(formatScanItem(item));
        }
      }
      break;
    }

    case "approve": {
      const approvalId = args[1];
      if (!approvalId) {
        console.error("Error: approval-id required");
        process.exit(1);
      }

      const reviewerIdx = args.indexOf("--reviewer");
      const notesIdx = args.indexOf("--notes");

      const reviewer = reviewerIdx !== -1 ? args[reviewerIdx + 1] : undefined;
      const notes = notesIdx !== -1 ? args[notesIdx + 1] : undefined;

      const item = await approveScan(approvalId, reviewer, notes);
      console.log(`\nScan APPROVED`);
      console.log(formatScanItem(item));
      break;
    }

    case "reject": {
      const approvalId = args[1];
      if (!approvalId) {
        console.error("Error: approval-id required");
        process.exit(1);
      }

      const reviewerIdx = args.indexOf("--reviewer");
      const reasonIdx = args.indexOf("--reason");

      const reviewer = reviewerIdx !== -1 ? args[reviewerIdx + 1] : undefined;
      const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;

      const item = await rejectScan(approvalId, reviewer, reason);
      console.log(`\nScan REJECTED`);
      console.log(formatScanItem(item));
      break;
    }

    case "stats": {
      const stats = await getApprovalStats();
      console.log(`
Scan Approval Queue Statistics
==============================
  Pending:  ${stats.pending}
  Approved: ${stats.approved}
  Rejected: ${stats.rejected}
  Expired:  ${stats.expired}

By Priority:
  Critical: ${stats.byPriority.critical}
  High:     ${stats.byPriority.high}
  Normal:   ${stats.byPriority.normal}
  Low:      ${stats.byPriority.low}
`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
