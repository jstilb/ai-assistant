#!/usr/bin/env bun
/**
 * ============================================================================
 * CallDetector - Detects active audio/video calls to suppress voice output
 * ============================================================================
 *
 * PURPOSE:
 * Prevents TTS voice output from firing during Zoom, Teams, Discord, Slack,
 * or Google Meet calls. Uses two detection methods:
 * 1. Process detection — app-specific call indicator processes
 * 2. Microphone-in-use detection — CoreAudio API (catches all apps)
 *
 * DESIGN:
 * - Fail-open: errors never block voice output
 * - All checks run in parallel with per-command timeouts
 * - Results are cached by callers (MessageRouter uses 30s TTL)
 *
 * ============================================================================
 */

import { z } from 'zod';

// ============================================================================
// Types & Schema
// ============================================================================

export const CallDetectorConfigSchema = z.object({
  /** Enable call detection guard */
  enabled: z.boolean().default(true),
  /** Apps to check via process detection */
  detectApps: z.array(z.enum(['zoom', 'teams', 'discord', 'slack'])).default(['zoom', 'teams', 'discord', 'slack']),
  /** Use CoreAudio mic detection as catch-all */
  useMicDetection: z.boolean().default(true),
  /** Per-command timeout in ms */
  timeoutMs: z.number().default(500),
  /** Allow critical priority messages to bypass call guard */
  allowCriticalOverride: z.boolean().default(true),
});

export type CallDetectorConfig = z.infer<typeof CallDetectorConfigSchema>;

export interface CallDetectionResult {
  onCall: boolean;
  detectedVia: string | null;
}

// ============================================================================
// Process Signals
// ============================================================================

/**
 * App-specific processes that indicate an active call.
 * Key = app name, Value = pgrep arguments.
 */
const APP_PROCESS_SIGNALS: Record<string, { args: string[]; label: string }> = {
  zoom: { args: ['-x', 'CptHost'], label: 'zoom:CptHost' },
  teams: { args: ['-x', 'MSTeams'], label: 'teams:MSTeams' },
};

// Discord and Slack always have helper processes running,
// so they're mic-detection only — no process signal entries.

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Run a subprocess with timeout, returning true if it exits with code 0.
 */
async function runCheck(cmd: string[], timeoutMs: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });

    const timeout = setTimeout(() => proc.kill(), timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a specific app's call indicator process is running.
 */
async function checkAppProcess(app: string, timeoutMs: number): Promise<string | null> {
  const signal = APP_PROCESS_SIGNALS[app];
  if (!signal) return null;

  const detected = await runCheck(['pgrep', ...signal.args], timeoutMs);
  return detected ? signal.label : null;
}

/**
 * Check if the system microphone is currently in use via CoreAudio.
 * Returns true when the orange mic indicator dot is active.
 *
 * Uses a Swift one-liner that queries kAudioDevicePropertyDeviceIsRunningSomewhere
 * on the default input audio device.
 */
async function checkMicInUse(timeoutMs: number): Promise<boolean> {
  const swiftCode = `
import CoreAudio
import Foundation
var addr = AudioObjectPropertyAddress(
  mSelector: kAudioHardwarePropertyDefaultInputDevice,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain)
var devID: AudioDeviceID = 0
var size = UInt32(MemoryLayout<AudioDeviceID>.size)
guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devID) == noErr else { exit(1) }
addr.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
var running: UInt32 = 0
size = UInt32(MemoryLayout<UInt32>.size)
guard AudioObjectGetPropertyData(devID, &addr, 0, nil, &size, &running) == noErr else { exit(1) }
exit(running != 0 ? 0 : 1)
`.trim();

  return runCheck(['swift', '-e', swiftCode], timeoutMs);
}

// ============================================================================
// Main Detection Entry Point
// ============================================================================

/**
 * Detect if the user is currently on a call.
 * Runs all checks in parallel, returns on first positive signal.
 * Fail-open: any error is treated as "not detected".
 */
export async function detectActiveCall(config: CallDetectorConfig): Promise<CallDetectionResult> {
  if (!config.enabled) {
    return { onCall: false, detectedVia: null };
  }

  const checks: Promise<string | null>[] = [];

  // Process-based detection for configured apps
  for (const app of config.detectApps) {
    checks.push(checkAppProcess(app, config.timeoutMs));
  }

  // Microphone detection as catch-all
  if (config.useMicDetection) {
    checks.push(
      checkMicInUse(config.timeoutMs).then(inUse => inUse ? 'mic:CoreAudio' : null)
    );
  }

  try {
    const results = await Promise.all(checks);
    const detected = results.find(r => r !== null);
    return {
      onCall: detected !== undefined,
      detectedVia: detected ?? null,
    };
  } catch {
    // Fail-open
    return { onCall: false, detectedVia: null };
  }
}
