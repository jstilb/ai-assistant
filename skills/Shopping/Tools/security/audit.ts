/**
 * Audit logging for Shopping skill
 *
 * All cart operations are logged to MEMORY/shopping-audit.jsonl
 * This provides forensic capability and tracks shopping activity.
 */

import { appendFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Audit log location
const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), '.claude')
const AUDIT_DIR = join(KAYA_HOME, 'MEMORY')
const AUDIT_FILE = join(AUDIT_DIR, 'shopping-audit.jsonl')

export type AuditAction =
  | 'session_created'
  | 'session_saved'
  | 'session_expired'
  | 'session_cleared'
  | 'search_performed'
  | 'cart_add_attempt'
  | 'cart_add_confirmed'
  | 'cart_add_rejected'
  | 'cart_add_success'
  | 'cart_add_failed'
  | 'cart_view'
  | 'checkout_blocked'
  | 'list_processed'
  | 'link_generated'
  | 'error'

export interface AuditEntry {
  timestamp: string
  action: AuditAction
  retailer: string
  item?: string
  quantity?: number
  confirmed?: boolean
  screenshot?: string
  url?: string
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * Log an audit entry
 *
 * @param action - The action being logged
 * @param data - Additional data for the entry
 */
export async function auditLog(
  action: AuditAction,
  data: Omit<AuditEntry, 'timestamp' | 'action'>
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    ...data
  }

  try {
    // Ensure directory exists
    if (!existsSync(AUDIT_DIR)) {
      await mkdir(AUDIT_DIR, { recursive: true })
    }

    // Append entry
    await appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch (err) {
    // Audit logging should never break the main flow
    console.error(`[Audit] Failed to log: ${err}`)
  }
}

/**
 * Log a cart add attempt (before user confirmation)
 */
export async function logCartAddAttempt(
  retailer: string,
  item: string,
  screenshot?: string
): Promise<void> {
  await auditLog('cart_add_attempt', {
    retailer,
    item,
    screenshot
  })
}

/**
 * Log user confirmation decision
 */
export async function logCartAddDecision(
  retailer: string,
  item: string,
  confirmed: boolean
): Promise<void> {
  await auditLog(confirmed ? 'cart_add_confirmed' : 'cart_add_rejected', {
    retailer,
    item,
    confirmed
  })
}

/**
 * Log successful cart addition
 */
export async function logCartAddSuccess(
  retailer: string,
  item: string,
  quantity: number
): Promise<void> {
  await auditLog('cart_add_success', {
    retailer,
    item,
    quantity
  })
}

/**
 * Log failed cart addition
 */
export async function logCartAddFailed(
  retailer: string,
  item: string,
  error: string
): Promise<void> {
  await auditLog('cart_add_failed', {
    retailer,
    item,
    error
  })
}

/**
 * Log checkout blocked (constitutional protection)
 */
export async function logCheckoutBlocked(
  retailer: string,
  reason: string
): Promise<void> {
  await auditLog('checkout_blocked', {
    retailer,
    error: reason,
    metadata: {
      constitutional: true,
      rule: 'Article X: Checkout Protection Gate'
    }
  })
}

/**
 * Log link generation (Tier 3)
 */
export async function logLinkGenerated(
  retailer: string,
  item: string,
  url: string
): Promise<void> {
  await auditLog('link_generated', {
    retailer,
    item,
    url
  })
}

/**
 * Log session events
 */
export async function logSession(
  action: 'session_created' | 'session_saved' | 'session_expired' | 'session_cleared',
  retailer: string
): Promise<void> {
  await auditLog(action, { retailer })
}

/**
 * Log error
 */
export async function logError(
  retailer: string,
  error: string,
  context?: string
): Promise<void> {
  await auditLog('error', {
    retailer,
    error,
    metadata: context ? { context } : undefined
  })
}
