#!/usr/bin/env bun
/**
 * VoiceInput.ts - Continuous Voice Input System for Kaya
 *
 * A production-grade continuous listening voice input system that:
 * 1. Listens continuously to the microphone
 * 2. Detects speech/silence using audio level analysis
 * 3. Transcribes using faster-whisper (local, free)
 * 4. Outputs transcribed text to stdout
 *
 * Usage:
 *   bun ~/.claude/lib/core/VoiceInput.ts start              # Start listening (continuous mode)
 *   bun ~/.claude/lib/core/VoiceInput.ts once               # Record once until silence, then exit
 *   bun ~/.claude/lib/core/VoiceInput.ts stop               # Stop listening (kills background process)
 *   bun ~/.claude/lib/core/VoiceInput.ts status             # Check if listening
 *   bun ~/.claude/lib/core/VoiceInput.ts test               # Test microphone and transcription
 *   bun ~/.claude/lib/core/VoiceInput.ts help               # Show this help
 *
 * Options:
 *   --silence-threshold=<pct>   Silence threshold as percentage (default: 1.0)
 *   --silence-duration=<sec>    Silence duration to trigger end (default: 1.5)
 *   --min-speech=<sec>          Minimum speech duration to process (default: 0.5)
 *   --max-duration=<sec>        Maximum recording duration (default: 120)
 *   --model=<model>             Whisper model (default: base.en)
 *   --json                      Output as JSON instead of plain text
 *   --verbose                   Enable verbose logging to stderr
 *
 * Environment:
 *   VOICE_INPUT_PID_FILE        PID file location (default: /tmp/voice-input.pid)
 *   VOICE_INPUT_TEMP_DIR        Temp directory for audio (default: /tmp/voice-input)
 *
 * Models:
 *   tiny, tiny.en, base, base.en (default), small, small.en, medium, medium.en,
 *   large-v1, large-v2, large-v3
 *
 * Notes:
 *   - Requires sox/rec: brew install sox
 *   - Uses faster-whisper via uv (automatically installed)
 *   - Terminal may need microphone permissions (System Preferences > Security & Privacy)
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, statSync, readdirSync } from "fs";
import { join } from "path";

// Configuration
const CONFIG = {
  pidFile: process.env.VOICE_INPUT_PID_FILE || "/tmp/voice-input.pid",
  tempDir: process.env.VOICE_INPUT_TEMP_DIR || "/tmp/voice-input",
  extractScript: join(process.env.HOME || "", ".claude/lib/core/extract-transcript.py"),
  sampleRate: 16000,  // Whisper expects 16kHz
  channels: 1,        // Mono for speech recognition
  format: "wav",      // WAV format for compatibility
  maxTempFileAge: 3600000,  // Clean up files older than 1 hour (in ms)
};

// Clean up old temp files on startup
function cleanupOldTempFiles(): void {
  if (!existsSync(CONFIG.tempDir)) return;

  const now = Date.now();
  try {
    const files = readdirSync(CONFIG.tempDir);
    for (const file of files) {
      const filePath = join(CONFIG.tempDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > CONFIG.maxTempFileAge) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore errors on individual files
      }
    }
  } catch {
    // Ignore errors
  }
}

// Parse arguments
interface ParsedArgs {
  command: "start" | "once" | "stop" | "status" | "test" | "help" | "claude";
  silenceThreshold: number;
  silenceDuration: number;
  minSpeechDuration: number;
  maxDuration: number;
  model: string;
  json: boolean;
  verbose: boolean;
  inject: boolean;      // Type into frontmost app via AppleScript
  autoSubmit: boolean;  // Press Enter after typing
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const command = (args[0] || "help") as ParsedArgs["command"];

  const getArg = (name: string, defaultValue: string): string => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split("=")[1] : defaultValue;
  };

  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  return {
    command,
    silenceThreshold: parseFloat(getArg("silence-threshold", "1.0")),
    silenceDuration: parseFloat(getArg("silence-duration", "1.5")),
    minSpeechDuration: parseFloat(getArg("min-speech", "0.5")),
    maxDuration: parseFloat(getArg("max-duration", "120")),
    model: getArg("model", "base.en"),
    json: hasFlag("json"),
    verbose: hasFlag("verbose"),
    inject: hasFlag("inject"),
    autoSubmit: hasFlag("auto-submit"),
  };
}

// Logger that respects verbose flag
interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
  success: (msg: string) => void;
}

function createLogger(verbose: boolean): Logger {
  return {
    info: (msg: string) => verbose && console.error(`[INFO] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
    debug: (msg: string) => verbose && console.error(`[DEBUG] ${msg}`),
    success: (msg: string) => verbose && console.error(`[OK] ${msg}`),
  };
}

// Show help
function showHelp(): void {
  console.log(`
VoiceInput - Continuous Voice Input System for Kaya

USAGE:
  bun ~/.claude/lib/core/VoiceInput.ts <command> [options]

COMMANDS:
  once      Record once until silence detected, transcribe, then exit
  start     Start continuous listening mode (background-able)
  claude    Continuous listening that types directly into Claude Code (hands-free!)
  stop      Stop the continuous listening process
  status    Check if voice input is running
  test      Test microphone and transcription setup
  help      Show this help message

OPTIONS:
  --silence-threshold=<pct>   Silence threshold as percentage (default: 1.0)
  --silence-duration=<sec>    Duration of silence to end recording (default: 1.5)
  --min-speech=<sec>          Minimum speech duration to process (default: 0.5)
  --max-duration=<sec>        Maximum recording duration (default: 120)
  --model=<model>             Whisper model to use (default: base.en)
  --json                      Output transcription as JSON
  --verbose                   Enable verbose logging to stderr
  --inject                    Type transcription into frontmost app (AppleScript)
  --auto-submit               Press Enter after typing (use with --inject)

MODELS (ordered by speed/accuracy):
  tiny, tiny.en       - Fastest, least accurate
  base, base.en       - Good balance (default)
  small, small.en     - Better accuracy, slower
  medium, medium.en   - High accuracy, slower
  large-v1/v2/v3      - Best accuracy, slowest

EXAMPLES:
  # Single recording with verbose output
  bun ~/.claude/lib/core/VoiceInput.ts once --verbose

  # Continuous mode with custom threshold
  bun ~/.claude/lib/core/VoiceInput.ts start --silence-threshold=2.0 --verbose

  # HIGH ACCURACY transcription
  bun ~/.claude/lib/core/VoiceInput.ts once --model=large-v3

  # JSON output for piping
  bun ~/.claude/lib/core/VoiceInput.ts once --json

  # HANDS-FREE CLAUDE CODE - types directly into terminal!
  bun ~/.claude/lib/core/VoiceInput.ts claude --verbose

  # Manual inject mode (type into any app)
  bun ~/.claude/lib/core/VoiceInput.ts start --inject --auto-submit --verbose

REQUIREMENTS:
  - sox: brew install sox
  - uv: automatically manages faster-whisper
  - Microphone permissions for terminal
  - Accessibility permissions for inject mode (System Preferences > Privacy > Accessibility)

`);
}

// Check if sox/rec is available
function checkSox(): { available: boolean; path?: string; version?: string } {
  const which = spawnSync("which", ["rec"], { encoding: "utf-8" });
  if (which.status !== 0) {
    return { available: false };
  }

  const path = which.stdout.trim();
  const version = spawnSync("sox", ["--version"], { encoding: "utf-8" });

  return {
    available: true,
    path,
    version: version.stdout?.trim() || "unknown",
  };
}

// Check if uv is available
function checkUv(): { available: boolean; path?: string; version?: string } {
  const which = spawnSync("which", ["uv"], { encoding: "utf-8" });
  if (which.status !== 0) {
    return { available: false };
  }

  const path = which.stdout.trim();
  const version = spawnSync("uv", ["--version"], { encoding: "utf-8" });

  return {
    available: true,
    path,
    version: version.stdout?.trim() || "unknown",
  };
}

// Check if extract-transcript.py exists
function checkExtractScript(): boolean {
  return existsSync(CONFIG.extractScript);
}

// Record audio until silence is detected
async function recordUntilSilence(
  outputPath: string,
  silenceThreshold: number,
  silenceDuration: number,
  maxDuration: number,
  log: Logger
): Promise<{ success: boolean; duration?: number }> {
  return new Promise((resolve) => {
    log.info(`Recording to ${outputPath}...`);
    log.info(`Silence threshold: ${silenceThreshold}%, duration: ${silenceDuration}s, max: ${maxDuration}s`);

    const startTime = Date.now();

    // Use rec (sox) with silence detection
    // The silence effect format:
    //   silence above_periods above_duration threshold below_periods below_duration threshold
    // We use:
    //   1 0.1 <threshold>% = wait for sound above threshold for at least 0.1s
    //   1 <duration> <threshold>% = then end after <duration>s of silence below threshold
    const recArgs = [
      "-q",                                    // Quiet mode
      "-r", CONFIG.sampleRate.toString(),      // Sample rate
      "-c", CONFIG.channels.toString(),        // Channels
      "-b", "16",                              // 16-bit
      "-e", "signed-integer",                  // Encoding
      outputPath,
      "silence",
      "1", "0.1", `${silenceThreshold}%`,      // Wait for sound above threshold
      "1", silenceDuration.toString(), `${silenceThreshold}%`,  // End after silence
      "trim", "0", maxDuration.toString(),     // Max duration
    ];

    log.debug(`Running: rec ${recArgs.join(" ")}`);

    const rec = spawn("rec", recArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrData = "";

    rec.stderr?.on("data", (data) => {
      stderrData += data.toString();
      const msg = data.toString().trim();
      if (msg) log.debug(`rec: ${msg}`);
    });

    rec.on("close", (code) => {
      const duration = (Date.now() - startTime) / 1000;
      log.info(`Recording stopped after ${duration.toFixed(1)}s (exit code: ${code})`);

      // Check if file was created and has meaningful content
      if (existsSync(outputPath)) {
        try {
          const stat = statSync(outputPath);
          // WAV header is 44 bytes, so anything > 1KB has some audio
          const hasContent = stat.size > 1000;
          log.info(`Recorded file: ${stat.size} bytes`);

          if (hasContent) {
            resolve({ success: true, duration });
          } else {
            log.debug("Recording too small, likely no speech");
            resolve({ success: false });
          }
        } catch (e) {
          log.error(`Failed to stat file: ${e}`);
          resolve({ success: false });
        }
      } else {
        log.error("Recording file not created");
        if (stderrData) {
          log.error(`rec stderr: ${stderrData}`);
        }
        resolve({ success: false });
      }
    });

    rec.on("error", (err) => {
      log.error(`Recording error: ${err.message}`);
      resolve({ success: false });
    });
  });
}

// Transcribe audio file using faster-whisper
async function transcribe(
  audioPath: string,
  model: string,
  log: Logger
): Promise<string | null> {
  log.info(`Transcribing with model: ${model}`);

  // Use uv to run the extract-transcript.py script
  const result = spawnSync("uv", [
    "run",
    CONFIG.extractScript,
    audioPath,
    "--model", model,
    "--format", "txt",
  ], {
    encoding: "utf-8",
    timeout: 120000,  // 2 minute timeout for large models
    maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
  });

  if (result.status !== 0) {
    log.error(`Transcription failed (exit ${result.status})`);
    if (result.stderr) {
      log.error(`stderr: ${result.stderr}`);
    }
    return null;
  }

  // Read the transcript file (same name as audio but .txt)
  const transcriptPath = audioPath.replace(/\.\w+$/, ".txt");
  if (existsSync(transcriptPath)) {
    const transcript = readFileSync(transcriptPath, "utf-8").trim();
    log.info(`Transcription complete: ${transcript.length} chars`);

    // Clean up transcript file
    try {
      unlinkSync(transcriptPath);
    } catch {
      // Ignore cleanup errors
    }

    return transcript;
  }

  log.error("Transcript file not found after transcription");
  return null;
}

// Output result
function output(text: string, isJson: boolean): void {
  if (isJson) {
    console.log(JSON.stringify({
      transcript: text,
      timestamp: new Date().toISOString(),
    }));
  } else {
    console.log(text);
  }
}

// Type text into frontmost application using AppleScript
async function injectText(text: string, autoSubmit: boolean, log: Logger): Promise<boolean> {
  // Escape text for AppleScript (escape backslashes and quotes)
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  // Build AppleScript with delay before Enter to ensure text is fully typed
  let script = `
tell application "System Events"
  keystroke "${escaped}"
`;

  if (autoSubmit) {
    // Add delay to ensure text is typed before pressing Enter
    script += `  delay 0.3\n`;
    script += `  key code 36\n`;  // 36 = Return key
  }

  script += `end tell`;

  log.debug(`Injecting ${text.length} chars into frontmost app`);

  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf-8",
    timeout: 5000,
  });

  if (result.status !== 0) {
    log.error(`AppleScript injection failed: ${result.stderr}`);
    return false;
  }

  log.success(`Injected: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  return true;
}

// Clean up temp file safely
function cleanupFile(path: string, log: Logger): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      log.debug(`Cleaned up: ${path}`);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Test mode - verify setup
async function runTest(args: ParsedArgs): Promise<void> {
  const log = createLogger(true);  // Always verbose in test mode

  console.error("\n=== VoiceInput System Test ===\n");

  // Check sox
  console.error("1. Checking sox/rec...");
  const soxInfo = checkSox();
  if (soxInfo.available) {
    console.error(`   OK: ${soxInfo.path} (${soxInfo.version})`);
  } else {
    console.error("   FAIL: sox/rec not found");
    console.error("   Fix: brew install sox");
    process.exit(1);
  }

  // Check uv
  console.error("\n2. Checking uv...");
  const uvInfo = checkUv();
  if (uvInfo.available) {
    console.error(`   OK: ${uvInfo.path} (${uvInfo.version})`);
  } else {
    console.error("   FAIL: uv not found");
    console.error("   Fix: curl -LsSf https://astral.sh/uv/install.sh | sh");
    process.exit(1);
  }

  // Check extract script
  console.error("\n3. Checking extract-transcript.py...");
  if (checkExtractScript()) {
    console.error(`   OK: ${CONFIG.extractScript}`);
  } else {
    console.error(`   FAIL: Script not found at ${CONFIG.extractScript}`);
    process.exit(1);
  }

  // Test microphone
  console.error("\n4. Testing microphone (2 second recording)...");
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }

  const testPath = join(CONFIG.tempDir, `test-${Date.now()}.wav`);

  // Simple 2-second recording
  const recResult = spawnSync("rec", [
    "-q", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer",
    testPath, "trim", "0", "2",
  ], {
    timeout: 10000,
    encoding: "utf-8",
  });

  if (recResult.status === 0 && existsSync(testPath)) {
    const stat = statSync(testPath);
    console.error(`   OK: Recorded ${stat.size} bytes`);

    // Test transcription
    console.error("\n5. Testing transcription (this may take a moment on first run)...");
    const transcript = await transcribe(testPath, args.model, log);

    cleanupFile(testPath, log);

    if (transcript !== null) {
      console.error(`   OK: Transcription working`);
      if (transcript.length > 0) {
        console.error(`   Transcript: "${transcript}"`);
      } else {
        console.error(`   (No speech detected in test recording)`);
      }
    } else {
      console.error("   FAIL: Transcription failed");
      process.exit(1);
    }
  } else {
    console.error("   FAIL: Could not record audio");
    console.error("   This may be a microphone permission issue.");
    console.error("   Check: System Preferences > Security & Privacy > Microphone");
    if (recResult.stderr) {
      console.error(`   Error: ${recResult.stderr}`);
    }
    process.exit(1);
  }

  console.error("\n=== All Tests Passed ===\n");
  console.error("Ready to use:");
  console.error("  bun ~/.claude/lib/core/VoiceInput.ts once --verbose");
  console.error("");
}

// Single recording session
async function recordOnce(args: ParsedArgs): Promise<void> {
  const log = createLogger(args.verbose);

  // Ensure temp directory exists
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }

  // Check dependencies
  if (!checkSox().available) {
    log.error("Required tool 'rec' (sox) not found. Install with: brew install sox");
    process.exit(1);
  }

  const audioPath = join(CONFIG.tempDir, `recording-${Date.now()}.wav`);

  log.info("Listening... Speak now. Recording will stop after silence.");

  // Record until silence
  const result = await recordUntilSilence(
    audioPath,
    args.silenceThreshold,
    args.silenceDuration,
    args.maxDuration,
    log
  );

  if (!result.success) {
    log.error("No speech detected or recording failed");
    cleanupFile(audioPath, log);
    process.exit(1);
  }

  // Transcribe
  const transcript = await transcribe(audioPath, args.model, log);

  // Clean up audio file
  cleanupFile(audioPath, log);

  if (transcript && transcript.length > 0) {
    output(transcript, args.json);
  } else {
    log.error("No transcription produced");
    process.exit(1);
  }
}

// Continuous recording loop
async function startContinuous(args: ParsedArgs): Promise<void> {
  const log = createLogger(args.verbose);

  // Check if already running
  if (existsSync(CONFIG.pidFile)) {
    const pid = parseInt(readFileSync(CONFIG.pidFile, "utf-8").trim());
    try {
      process.kill(pid, 0);  // Check if process exists
      log.error(`Already running (PID: ${pid}). Use 'stop' command first.`);
      process.exit(1);
    } catch {
      // Process doesn't exist, remove stale PID file
      unlinkSync(CONFIG.pidFile);
    }
  }

  // Write PID file
  writeFileSync(CONFIG.pidFile, process.pid.toString());

  // Ensure temp directory exists
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }

  // Check dependencies
  if (!checkSox().available) {
    log.error("Required tool 'rec' (sox) not found. Install with: brew install sox");
    unlinkSync(CONFIG.pidFile);
    process.exit(1);
  }

  log.info(`Continuous listening started (PID: ${process.pid})`);
  log.info("Press Ctrl+C to stop");

  // Handle graceful shutdown
  const cleanup = () => {
    log.info("Shutting down...");
    if (existsSync(CONFIG.pidFile)) {
      unlinkSync(CONFIG.pidFile);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Continuous recording loop
  while (true) {
    const audioPath = join(CONFIG.tempDir, `recording-${Date.now()}.wav`);

    log.info("Listening...");

    // Record until silence
    const result = await recordUntilSilence(
      audioPath,
      args.silenceThreshold,
      args.silenceDuration,
      args.maxDuration,
      log
    );

    if (result.success) {
      // Transcribe
      const transcript = await transcribe(audioPath, args.model, log);

      if (transcript && transcript.length > 0) {
        if (args.inject) {
          // Inject into frontmost app
          await injectText(transcript, args.autoSubmit, log);
        } else {
          output(transcript, args.json);
        }
      }
    }

    // Clean up audio file
    cleanupFile(audioPath, log);

    // Small delay before next recording
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Stop continuous recording
function stopContinuous(log: Logger): void {
  if (!existsSync(CONFIG.pidFile)) {
    console.log(JSON.stringify({ stopped: false, reason: "not_running" }));
    return;
  }

  const pid = parseInt(readFileSync(CONFIG.pidFile, "utf-8").trim());

  try {
    process.kill(pid, "SIGTERM");
    console.log(JSON.stringify({ stopped: true, pid }));
    unlinkSync(CONFIG.pidFile);
  } catch (e) {
    log.error(`Failed to stop process: ${e}`);
    // Remove stale PID file
    if (existsSync(CONFIG.pidFile)) {
      unlinkSync(CONFIG.pidFile);
    }
    console.log(JSON.stringify({ stopped: false, reason: "process_not_found", pid }));
  }
}

// Check status
function checkStatus(): void {
  if (!existsSync(CONFIG.pidFile)) {
    console.log(JSON.stringify({ running: false }));
    return;
  }

  const pid = parseInt(readFileSync(CONFIG.pidFile, "utf-8").trim());

  try {
    process.kill(pid, 0);  // Check if process exists
    console.log(JSON.stringify({ running: true, pid }));
  } catch {
    console.log(JSON.stringify({ running: false, stale_pid: pid }));
    // Remove stale PID file
    unlinkSync(CONFIG.pidFile);
  }
}

// Claude Code integration mode - continuous listening with direct injection
async function startClaudeMode(args: ParsedArgs): Promise<void> {
  const log = createLogger(args.verbose);

  // Check if already running
  if (existsSync(CONFIG.pidFile)) {
    const pid = parseInt(readFileSync(CONFIG.pidFile, "utf-8").trim());
    try {
      process.kill(pid, 0);
      log.error(`Already running (PID: ${pid}). Use 'stop' command first.`);
      process.exit(1);
    } catch {
      unlinkSync(CONFIG.pidFile);
    }
  }

  // Write PID file
  writeFileSync(CONFIG.pidFile, process.pid.toString());

  // Ensure temp directory exists
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }

  // Check dependencies
  if (!checkSox().available) {
    log.error("Required tool 'rec' (sox) not found. Install with: brew install sox");
    unlinkSync(CONFIG.pidFile);
    process.exit(1);
  }

  console.error("\n╔════════════════════════════════════════════════════════════╗");
  console.error("║  🎙️  CLAUDE CODE VOICE INPUT - HANDS-FREE MODE             ║");
  console.error("╠════════════════════════════════════════════════════════════╣");
  console.error("║  Speak naturally. Your words will be typed into Claude.   ║");
  console.error("║  Pause for 1.5s to end a message and auto-submit.         ║");
  console.error("║  Press Ctrl+C to stop.                                    ║");
  console.error("╚════════════════════════════════════════════════════════════╝\n");

  log.info(`Claude mode started (PID: ${process.pid})`);
  log.info(`Model: ${args.model}, Silence: ${args.silenceDuration}s`);

  // Handle graceful shutdown
  const cleanup = () => {
    console.error("\n👋 Voice input stopped. Goodbye!");
    if (existsSync(CONFIG.pidFile)) {
      unlinkSync(CONFIG.pidFile);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Continuous recording loop
  while (true) {
    const audioPath = join(CONFIG.tempDir, `recording-${Date.now()}.wav`);

    console.error("🎧 Listening... (speak now)");

    // Record until silence
    const result = await recordUntilSilence(
      audioPath,
      args.silenceThreshold,
      args.silenceDuration,
      args.maxDuration,
      log
    );

    if (result.success) {
      console.error("⚡ Transcribing...");

      // Transcribe
      const transcript = await transcribe(audioPath, args.model, log);

      if (transcript && transcript.length > 0) {
        console.error(`📝 You said: "${transcript}"`);

        // Inject into Claude Code with auto-submit
        const injected = await injectText(transcript, true, log);

        if (injected) {
          console.error("✅ Sent to Claude!\n");
        } else {
          console.error("⚠️  Injection failed - check Accessibility permissions\n");
          console.error("   System Preferences > Security & Privacy > Accessibility");
          console.error("   Enable your terminal app.\n");
        }
      } else {
        console.error("🔇 No speech detected\n");
      }
    }

    // Clean up audio file
    cleanupFile(audioPath, log);

    // Small delay before next recording
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// Main entry point
async function main(): Promise<void> {
  const args = parseArgs();
  const log = createLogger(args.verbose);

  // Clean up old temp files on any command that uses recording
  if (["start", "claude", "once", "test"].includes(args.command)) {
    cleanupOldTempFiles();
    log.debug("Cleaned up old temp files");
  }

  switch (args.command) {
    case "help":
      showHelp();
      break;
    case "start":
      await startContinuous(args);
      break;
    case "claude":
      await startClaudeMode(args);
      break;
    case "once":
      await recordOnce(args);
      break;
    case "stop":
      stopContinuous(log);
      break;
    case "status":
      checkStatus();
      break;
    case "test":
      await runTest(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
