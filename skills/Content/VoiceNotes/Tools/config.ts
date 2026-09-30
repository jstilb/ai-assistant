/**
 * config.ts - VoiceNotes configuration: defaults + user override loading.
 *
 * Sources are scanned for new audio files; both phone and desktop feed them:
 *   - ~/VoiceNotesInbox                 (local desktop drop folder)
 *   - ~/Library/Mobile Documents/com~apple~CloudDocs/VoiceNotesInbox
 *                                        (iCloud Drive — visible in the iPhone Files app)
 *   - Apple Voice Memos recordings dir   (auto-added if present on this Mac)
 *
 * User overrides live in USER/SKILLCUSTOMIZATIONS/VoiceNotes/config.json and are
 * shallow-merged over the defaults.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface VoiceNotesConfig {
  /** Folders scanned for new audio files. */
  sources: string[];
  /** Absolute path to the Obsidian vault root. */
  vaultPath: string;
  /** Subfolder (under the routed category) where notes are written. */
  noteSubfolder: string;
  /** Fallback top-level folder when no category fits. */
  defaultCategory: string;
  /** faster-whisper model used by extract-transcript.py. */
  whisperModel: string;
  /** Where processed audio is moved (originals are never deleted). */
  archiveDir: string;
  /** When true, leave audio in the source folder instead of archiving it. */
  keepAudio: boolean;
  /** JSON ledger of already-processed files (keyed by content hash). */
  ledgerPath: string;
  /** Inference tier for the organize step. */
  inferenceLevel: "fast" | "standard" | "smart";
}

const HOME = homedir();

export const KAYA_HOME = (() => {
  const env = process.env.KAYA_HOME;
  if (env && existsSync(env)) return env;
  return join(HOME, ".claude");
})();

/** Stable, worktree-independent state root. */
const STATE_ROOT = join(HOME, ".kaya", "voicenotes");

const APPLE_VOICE_MEMOS = join(
  HOME,
  "Library",
  "Group Containers",
  "group.com.apple.VoiceMemos.shared",
  "Recordings",
);

export function defaultConfig(): VoiceNotesConfig {
  const sources = [
    join(HOME, "VoiceNotesInbox"),
    join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "VoiceNotesInbox"),
  ];
  // Only scan the Apple Voice Memos store if it actually holds recordings on
  // this Mac (it is empty/absent when memos live only in iCloud, undownloaded).
  if (existsSync(APPLE_VOICE_MEMOS)) sources.push(APPLE_VOICE_MEMOS);

  return {
    sources,
    vaultPath: join(HOME, "Desktop", "obsidian"),
    noteSubfolder: "Voice Notes",
    defaultCategory: "Voice Notes",
    whisperModel: "large-v3",
    archiveDir: join(STATE_ROOT, "archive"),
    keepAudio: false,
    ledgerPath: join(STATE_ROOT, "ledger.json"),
    inferenceLevel: "standard",
  };
}

export function loadConfig(): VoiceNotesConfig {
  const base = defaultConfig();
  const overridePath = join(
    KAYA_HOME,
    "USER",
    "SKILLCUSTOMIZATIONS",
    "VoiceNotes",
    "config.json",
  );
  if (existsSync(overridePath)) {
    try {
      const override = JSON.parse(readFileSync(overridePath, "utf-8")) as Partial<VoiceNotesConfig>;
      return { ...base, ...override };
    } catch (err) {
      console.error(`[VoiceNotes] Ignoring invalid config override: ${(err as Error).message}`);
    }
  }
  return base;
}

/** Audio/video extensions extract-transcript.py can handle. */
export const SUPPORTED_EXTENSIONS = new Set([
  ".m4a", ".mp3", ".wav", ".flac", ".ogg", ".aac", ".wma",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv",
]);
