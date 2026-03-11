#!/usr/bin/env bun
/**
 * ContextManagerState.ts - Session state for ContextManager
 *
 * Tracks what context is loaded in the current session.
 * Uses StateManager for type-safe persistence.
 *
 * State file: MEMORY/STATE/context-session.json
 *
 * CLI: bun ContextManagerState.ts status
 * CLI: bun ContextManagerState.ts reset
 * API: import { getSessionState, updateSessionState } from "./ContextManagerState"
 */

import { z } from 'zod';
import { join } from 'path';
import { createStateManager } from '../../../lib/core/StateManager';

const KAYA_DIR = process.env.KAYA_DIR || join(process.env.HOME!, '.claude');

// Schema for loaded file tracking
const LoadedFileSchema = z.object({
  path: z.string(),
  tokens: z.number(),
  compressed: z.boolean().default(false),
  loadedAt: z.string(),
  tier: z.enum(['boot', 'profile', 'on-demand']),
});

// Schema for classification result
const ClassificationSchema = z.object({
  profile: z.string(),
  confidence: z.number(),
  stage: z.enum(['keyword', 'inference']),
  reasoning: z.string().optional(),
  timestamp: z.string(),
});

// Main session state schema
const SessionStateSchema = z.object({
  sessionId: z.string(),
  currentProfile: z.string().default('boot'),
  classification: ClassificationSchema.nullable().default(null),
  loadedFiles: z.array(LoadedFileSchema).default([]),
  totalTokensUsed: z.number().default(0),
  tokenBudget: z.number().default(200),
  sessionStarted: z.string(),
  lastUpdated: z.string(),
  profileChanges: z.number().default(0),
});

export type SessionState = z.infer<typeof SessionStateSchema>;
export type LoadedFile = z.infer<typeof LoadedFileSchema>;
export type Classification = z.infer<typeof ClassificationSchema>;

const STATE_PATH = join(KAYA_DIR, 'MEMORY', 'STATE', 'context-session.json');

const stateManager = createStateManager({
  path: STATE_PATH,
  schema: SessionStateSchema,
  defaults: () => ({
    sessionId: '',
    currentProfile: 'boot',
    classification: null,
    loadedFiles: [],
    totalTokensUsed: 0,
    tokenBudget: 200,
    sessionStarted: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    profileChanges: 0,
  }),
});

export async function getSessionState(): Promise<SessionState> {
  return stateManager.load();
}

export async function updateSessionState(
  updater: (state: SessionState) => SessionState
): Promise<SessionState> {
  return stateManager.update(updater);
}

export async function resetSessionState(sessionId: string): Promise<SessionState> {
  const now = new Date().toISOString();
  const fresh: SessionState = {
    sessionId,
    currentProfile: 'boot',
    classification: null,
    loadedFiles: [],
    totalTokensUsed: 0,
    tokenBudget: 200,
    sessionStarted: now,
    lastUpdated: now,
    profileChanges: 0,
  };
  await stateManager.save(fresh);
  return fresh;
}

export async function recordLoadedFile(file: LoadedFile): Promise<void> {
  await stateManager.update((state) => ({
    ...state,
    loadedFiles: [...state.loadedFiles, file],
    totalTokensUsed: state.totalTokensUsed + file.tokens,
  }));
}

export async function setProfile(
  profile: string,
  budget: number,
  classification: Classification
): Promise<void> {
  await stateManager.update((state) => ({
    ...state,
    currentProfile: profile,
    tokenBudget: budget,
    classification,
    profileChanges: state.profileChanges + 1,
  }));
}

export { stateManager };

// CLI
if (import.meta.main) {
  const cmd = process.argv[2];

  if (cmd === 'status') {
    const state = await getSessionState();
    console.log(JSON.stringify(state, null, 2));
  } else if (cmd === 'reset') {
    const sessionId = process.argv[3] || 'manual-reset';
    const state = await resetSessionState(sessionId);
    console.log('State reset:', JSON.stringify(state, null, 2));
  } else {
    console.log('Usage:');
    console.log('  bun ContextManagerState.ts status   - Show current session state');
    console.log('  bun ContextManagerState.ts reset [session-id] - Reset state');
  }
}
