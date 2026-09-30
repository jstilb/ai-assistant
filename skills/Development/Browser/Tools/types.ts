/**
 * Browser skill shared types.
 *
 * SessionStateSchema is used by both Browse.ts and BrowserSession.ts
 * to validate and persist browser session state via StateManager.
 */

import { z } from 'zod'

/** Single source of truth for the CDP/HTTP port used by BrowserSession.ts */
export const BROWSER_CDP_PORT = 9222

export const SessionStateSchema = z.object({
  pid: z.number(),
  port: z.number(),
  sessionId: z.string(),
  sessionToken: z.string().optional(),
  startedAt: z.string(),
  headless: z.boolean(),
  url: z.string(),
})

export type SessionState = z.infer<typeof SessionStateSchema>
