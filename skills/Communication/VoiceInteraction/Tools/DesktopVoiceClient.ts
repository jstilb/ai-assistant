#!/usr/bin/env bun
/**
 * DesktopVoiceClient.ts - Local mic/speaker voice interaction for desktop
 *
 * Provides always-available voice interaction on macOS:
 * - Push-to-talk mode (hotkey-triggered recording)
 * - VAD mode (voice activity detection for hands-free)
 * - Real-time mode (WebSocket to RealtimeVoiceServer on port 8882)
 * - Streaming TTS playback through system speakers
 * - Between-turn interruption support (new input cancels current response)
 *
 * Usage:
 *   bun DesktopVoiceClient.ts start                    # Start in push-to-talk mode
 *   bun DesktopVoiceClient.ts start --mode=vad          # Start in VAD mode
 *   bun DesktopVoiceClient.ts start --mode=realtime     # Start in real-time WebSocket mode
 *   bun DesktopVoiceClient.ts stop                      # Stop client
 *   bun DesktopVoiceClient.ts status                    # Check if running
 *   bun DesktopVoiceClient.ts conversation              # Single conversation turn
 */

import { spawnSync, spawn } from "child_process";
import { existsSync, writeFileSync } from "fs";
import {
  VOICE_INPUT_TOOL,
  VOICE_RESPONSE_TOOL,
  INTERRUPTION_TOOL,
  INFERENCE_TOOL,
  ensureTempDir,
  getVoiceInteractionConfig,
  getIdentity,
  getSessionManager,
  getPidManager,
  isExitCommand,
  getLocalTTSConfig,
  getRealtimeVoiceConfig,
  type ConversationSession,
  type VoiceInteractionConfig,
} from "./VoiceCommon.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";

// ============================================================================
// Real-Time WebSocket Client Mode
// ============================================================================

interface RealtimeClientState {
  ws: WebSocket | null;
  sessionId: string | null;
  connected: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  recording: boolean;
  aborted: boolean;
}

/**
 * Start real-time voice mode via WebSocket to RealtimeVoiceServer.
 * Falls back to batch pipeline if the server is unavailable.
 */
async function startRealtime(): Promise<void> {
  const rtConfig = getRealtimeVoiceConfig();
  const wsUrl = `ws://localhost:${rtConfig.port}/ws`;

  // Check if server is reachable
  const serverAvailable = await checkRealtimeServer(rtConfig.port);
  if (!serverAvailable) {
    console.error(`Real-time voice server not available on port ${rtConfig.port}.`);
    console.error("Falling back to batch pipeline...");

    // Speak fallback notification
    spawnSync("bun", [VOICE_RESPONSE_TOOL, "speak", "Switching to standard voice mode."], {
      encoding: "utf-8",
      timeout: 10000,
    });

    await startContinuous("push-to-talk");
    return;
  }

  const state: RealtimeClientState = {
    ws: null,
    sessionId: null,
    connected: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    recording: false,
    aborted: false,
  };

  // Record PID via StateManager
  const pidManager = getPidManager();
  await pidManager.save({ pid: process.pid, startedAt: new Date().toISOString() });

  console.error(`
--- KAYA DESKTOP VOICE - REALTIME ---
Connected to real-time voice server on port ${rtConfig.port}.
Speak naturally. Kaya will respond via speakers.
Say "goodbye" or "stop listening" to end.
Press Ctrl+C to force stop.
`);

  try { notifySync("Starting real-time desktop voice mode"); } catch { /* non-blocking */ }

  // Graceful shutdown
  const cleanup = () => {
    state.aborted = true;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close(1000, "Client shutdown");
    }
    console.error("\nReal-time voice interaction ended.");
    pidManager.save({}).catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Connect and run
  await connectAndRun(wsUrl, state, cleanup);
}

/**
 * Check if the real-time voice server is reachable.
 */
async function checkRealtimeServer(port: number): Promise<boolean> {
  try {
    const response = await httpClient.fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Connect to WebSocket and run the real-time voice loop.
 * Implements reconnection with exponential backoff.
 */
async function connectAndRun(
  wsUrl: string,
  state: RealtimeClientState,
  cleanup: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    function connect(): void {
      if (state.aborted) {
        resolve();
        return;
      }

      console.error(`Connecting to ${wsUrl}...`);
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        state.connected = true;
        console.error("Connected to real-time voice server.");

        // Send session_init for potential recovery
        if (state.sessionId) {
          ws.send(JSON.stringify({ type: "session_init", sessionId: state.sessionId }));
        }

        // Start heartbeat
        const heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          } else {
            clearInterval(heartbeat);
          }
        }, 15000);

        // Start recording loop
        recordAndSendLoop(ws, state, cleanup);
      };

      ws.onmessage = (event) => {
        handleServerMessage(event.data as string, state);
      };

      ws.onclose = (event) => {
        state.connected = false;
        console.error(`WebSocket closed: ${event.code} ${event.reason || ""}`);

        if (state.aborted) {
          resolve();
          return;
        }

        // Attempt reconnection with exponential backoff
        if (state.reconnectAttempts < state.maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
          state.reconnectAttempts++;
          console.error(`Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts})...`);
          setTimeout(connect, delay);
        } else {
          console.error("Max reconnection attempts reached. Falling back to batch pipeline.");
          spawnSync("bun", [VOICE_RESPONSE_TOOL, "speak", "Connection lost. Switching to standard voice mode."], {
            encoding: "utf-8",
            timeout: 10000,
          });
          // Fall back to batch mode
          startContinuous("push-to-talk").then(resolve).catch(() => resolve());
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
    }

    connect();
  });
}

/**
 * Record audio and send to the real-time voice server in a loop.
 */
async function recordAndSendLoop(
  ws: WebSocket,
  state: RealtimeClientState,
  cleanup: () => void,
): Promise<void> {
  const voiceConfig = getVoiceInteractionConfig();

  while (!state.aborted && ws.readyState === WebSocket.OPEN) {
    try {
      // Record audio via sox
      const tmpFile = `/tmp/voice-rt-${Date.now()}.wav`;
      const recordResult = spawnSync("sox", [
        "-d",               // default audio device
        "-r", "16000",      // 16kHz sample rate
        "-c", "1",          // mono
        "-b", "16",         // 16-bit
        tmpFile,
        "silence", "1", "0.1", `${voiceConfig.silenceThreshold}%`,
        "1", `${voiceConfig.silenceDuration}`, `${voiceConfig.silenceThreshold}%`,
        "trim", "0", `${voiceConfig.maxDuration}`,
      ], {
        encoding: "utf-8",
        timeout: (voiceConfig.maxDuration + 10) * 1000,
      });

      if (state.aborted || ws.readyState !== WebSocket.OPEN) break;

      if (recordResult.status !== 0 || !existsSync(tmpFile)) {
        continue; // Recording failed or was empty, try again
      }

      // Read the audio file
      const audioFile = Bun.file(tmpFile);
      if (!(await audioFile.exists()) || audioFile.size === 0) {
        continue;
      }

      const audioData = await audioFile.arrayBuffer();

      // Clean up temp file
      try { writeFileSync(tmpFile, ""); } catch { /* ignore */ }

      if (audioData.byteLength < 1000) {
        continue; // Too short, likely silence
      }

      // Send audio as binary over WebSocket
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioData);
        state.recording = false;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("exit") || errMsg.includes("goodbye")) {
        cleanup();
        break;
      }
      console.error(`Recording error: ${errMsg}`);
    }

    // Brief pause between recordings
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Handle messages from the real-time voice server.
 */
function handleServerMessage(data: string, state: RealtimeClientState): void {
  try {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case "status":
        // Status updates (listening/thinking/speaking)
        if (msg.state === "listening") {
          console.error("Listening...");
        } else if (msg.state === "thinking") {
          console.error("Thinking...");
        } else if (msg.state === "speaking") {
          console.error("Speaking...");
        }
        break;

      case "transcript":
        console.error(`You said: "${msg.text}"`);
        // Check for exit commands
        if (isExitCommand(msg.text)) {
          state.aborted = true;
        }
        break;

      case "response_text":
        console.error(`Kaya: "${msg.text}"`);
        break;

      case "audio":
        // Play audio response through speakers
        playBase64Audio(msg.data);
        break;

      case "error":
        console.error(`Server error: ${msg.message}`);
        break;

      case "session_ack": {
        const ack = msg as { sessionId: string; resumed: boolean; conversationLength: number };
        state.sessionId = ack.sessionId;

        if (ack.resumed) {
          console.error(`Session recovered (${ack.conversationLength} messages preserved)`);
          // Speak reconnection greeting (non-blocking)
          spawn("bun", [VOICE_RESPONSE_TOOL, "speak", "I'm back. Where were we?"], {
            stdio: "ignore",
          });
        } else if (state.reconnectAttempts > 0) {
          console.error("Started new session.");
        }

        state.reconnectAttempts = 0;
        break;
      }

      case "pong":
        // Heartbeat response -- connection alive
        break;

      default:
        break;
    }
  } catch {
    // Non-JSON message, ignore
  }
}

/**
 * Play base64-encoded audio through speakers via afplay.
 */
function playBase64Audio(base64Data: string): void {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const tmpFile = `/tmp/voice-play-${Date.now()}.wav`;
    writeFileSync(tmpFile, buffer);

    // Play asynchronously so we don't block message processing
    const child = spawn("afplay", [tmpFile], {
      stdio: "ignore",
    });

    child.on("exit", () => {
      // Clean up temp file after playback
      try { writeFileSync(tmpFile, ""); } catch { /* ignore */ }
    });
  } catch (err) {
    console.error("Audio playback error:", err);
  }
}

// ============================================================================
// Batch Pipeline (existing functionality)
// ============================================================================

/**
 * Validate required dependencies before starting voice client
 */
function validateDependencies(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  // Check sox (audio recording)
  const soxCheck = spawnSync("which", ["sox"], { encoding: "utf-8" });
  if (soxCheck.status !== 0) missing.push("sox (brew install sox)");

  // Check afplay (audio playback, macOS built-in)
  const afplayCheck = spawnSync("which", ["afplay"], { encoding: "utf-8" });
  if (afplayCheck.status !== 0) missing.push("afplay (macOS built-in, should exist)");

  // Check uv (Python package manager for faster-whisper)
  const uvCheck = spawnSync("which", ["uv"], { encoding: "utf-8" });
  if (uvCheck.status !== 0) missing.push("uv (curl -LsSf https://astral.sh/uv/install.sh | sh)");

  // Check VoiceInput tool exists
  if (!existsSync(VOICE_INPUT_TOOL)) {
    missing.push(`VoiceInput tool (${VOICE_INPUT_TOOL})`);
  }

  // Check local TTS config
  try {
    const config = getLocalTTSConfig();
    if (!config.voiceId) missing.push("Local voice ID (settings.json daidentity.localVoice.id)");
    if (!config.serverUrl) missing.push("TTS server URL (settings.json)");
  } catch {
    missing.push("Local TTS configuration (settings.json)");
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Build conversation context for inference, returning separate system and user prompts
 */
function buildConversationPrompt(session: ConversationSession, newInput: string): { systemPrompt: string; userPrompt: string } {
  const { assistantName, userName } = getIdentity();

  // Build context from recent messages (last 10)
  const recentMessages = session.messages.slice(-10);
  const history = recentMessages
    .map((m) => `${m.role === "user" ? userName : assistantName}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are ${assistantName}, a personal AI assistant having a voice conversation with ${userName}.
Respond naturally and concisely as if speaking aloud. Keep responses under 3 sentences unless the question requires more detail.
Do not use markdown formatting, bullet points, or special characters - this will be spoken aloud.`;

  const userPrompt = `${history ? `Recent conversation:\n${history}\n\n` : ""}${userName}: ${newInput}`;

  return { systemPrompt, userPrompt };
}

/**
 * Run one conversation turn: listen -> think -> speak
 */
async function conversationTurn(config: VoiceInteractionConfig): Promise<{
  userSaid: string;
  kayaSaid: string;
}> {
  const manager = getSessionManager();
  const session = await manager.load();

  // Reset if session is more than 1 hour old
  const sessionAge = Date.now() - new Date(session.startedAt).getTime();
  if (sessionAge >= 3600000) {
    await manager.save({
      id: `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      messages: [],
      turnCount: 0,
    });
  }

  const currentSession = await manager.load();
  const sessionId = `turn-${currentSession.turnCount}`;

  // Step 1: Listen (record + transcribe)
  console.error("Listening... (speak now)");

  const listenResult = spawnSync("bun", [
    VOICE_INPUT_TOOL, "once",
    `--model=${config.whisperModel}`,
    `--silence-threshold=${config.silenceThreshold}`,
    `--silence-duration=${config.silenceDuration}`,
    `--max-duration=${config.maxDuration}`,
  ], {
    encoding: "utf-8",
    timeout: (config.maxDuration + 30) * 1000,
  });

  if (listenResult.status !== 0) {
    throw new Error("No speech detected or recording failed");
  }

  const userSaid = listenResult.stdout.trim();
  if (!userSaid) {
    throw new Error("Empty transcription");
  }

  console.error(`You said: "${userSaid}"`);

  // Step 2: Think (generate response via Inference)
  console.error("Thinking...");

  // Register active response for interruption tracking
  spawnSync("bun", [INTERRUPTION_TOOL, "register", sessionId, "desktop"], {
    encoding: "utf-8",
    timeout: 5000,
  });

  const { systemPrompt, userPrompt } = buildConversationPrompt(currentSession, userSaid);
  const inferResult = spawnSync("bun", [
    INFERENCE_TOOL,
    "--level", config.inferenceLevel,
    systemPrompt,
    userPrompt,
  ], {
    encoding: "utf-8",
    timeout: 30000,
  });

  let kayaSaid = "";
  if (inferResult.status === 0) {
    kayaSaid = inferResult.stdout.trim();
  }

  if (!kayaSaid) {
    kayaSaid = "I'm sorry, I couldn't process that. Could you try again?";
  }

  console.error(`Kaya: "${kayaSaid}"`);

  // Step 3: Speak (TTS + playback)
  console.error("Speaking...");

  spawnSync("bun", [VOICE_RESPONSE_TOOL, "speak", kayaSaid], {
    encoding: "utf-8",
    timeout: 60000,
  });

  // Cancel interruption tracking
  spawnSync("bun", [INTERRUPTION_TOOL, "cancel", sessionId], {
    encoding: "utf-8",
    timeout: 5000,
  });

  // Update session via StateManager (spread all required fields)
  await manager.update((s) => ({
    ...s,
    messages: [
      ...s.messages.slice(-18), // Keep last 18 + 2 new = 20
      { role: "user" as const, content: userSaid, timestamp: new Date().toISOString() },
      { role: "assistant" as const, content: kayaSaid, timestamp: new Date().toISOString() },
    ],
    turnCount: s.turnCount + 1,
  }));

  return { userSaid, kayaSaid };
}

/**
 * Start continuous voice interaction loop (batch pipeline)
 */
async function startContinuous(modeOverride?: "push-to-talk" | "vad"): Promise<void> {
  // Validate dependencies before starting
  const deps = validateDependencies();
  if (!deps.valid) {
    console.error("Missing dependencies:");
    for (const dep of deps.missing) {
      console.error(`  - ${dep}`);
    }
    console.error("\nInstall missing dependencies and try again.");
    process.exit(1);
  }

  const config = getVoiceInteractionConfig();
  if (modeOverride) config.mode = modeOverride;

  // Check if already running via StateManager
  const pidManager = getPidManager();
  const pidState = await pidManager.load();
  if (pidState.pid) {
    try {
      process.kill(pidState.pid, 0);
      console.error(`Already running (PID: ${pidState.pid}). Use 'stop' first.`);
      process.exit(1);
    } catch {
      // Stale PID, clear it
    }
  }

  // Record PID via StateManager
  await pidManager.save({ pid: process.pid, startedAt: new Date().toISOString() });

  console.error(`
--- KAYA DESKTOP VOICE - ${config.mode.toUpperCase()} ---
Speak naturally. Kaya will listen and respond.
Say "goodbye" or "stop listening" to end.
Press Ctrl+C to force stop.
`);

  // Voice notification before starting desktop voice mode
  try { notifySync(`Starting desktop voice mode in ${config.mode} mode`); } catch { /* non-blocking */ }

  // Graceful shutdown
  const cleanup = () => {
    console.error("\nVoice interaction ended.");
    pidManager.save({}).catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Continuous loop
  while (true) {
    try {
      const { userSaid } = await conversationTurn(config);

      // Check for exit
      if (isExitCommand(userSaid)) {
        spawnSync("bun", [VOICE_RESPONSE_TOOL, "speak", "Goodbye!"], {
          encoding: "utf-8",
          timeout: 15000,
        });
        cleanup();
        break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${errMsg}`);
    }

    // Brief pause between turns
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Stop the desktop voice client
 */
async function stop(): Promise<void> {
  const pidManager = getPidManager();
  const pidState = await pidManager.load();

  if (!pidState.pid) {
    console.log(JSON.stringify({ stopped: false, reason: "not_running" }));
    return;
  }

  try {
    process.kill(pidState.pid, "SIGTERM");
    console.log(JSON.stringify({ stopped: true, pid: pidState.pid }));
  } catch {
    console.log(JSON.stringify({ stopped: false, reason: "process_not_found", pid: pidState.pid }));
  }

  await pidManager.save({});

  // Also cancel any active responses
  spawnSync("bun", [INTERRUPTION_TOOL, "cancel-all"], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

/**
 * Check if desktop voice is running
 */
async function status(): Promise<void> {
  const pidManager = getPidManager();
  const pidState = await pidManager.load();

  if (!pidState.pid) {
    console.log(JSON.stringify({ running: false }));
    return;
  }

  try {
    process.kill(pidState.pid, 0);
    const manager = getSessionManager();
    const session = await manager.load();
    console.log(JSON.stringify({
      running: true,
      pid: pidState.pid,
      sessionId: session.id,
      turnCount: session.turnCount,
      startedAt: session.startedAt,
    }));
  } catch {
    console.log(JSON.stringify({ running: false, stale_pid: pidState.pid }));
    await pidManager.save({});
  }
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  ensureTempDir();

  switch (command) {
    case "--help":
    case "-h":
    case "help": {
      console.log(`DesktopVoiceClient - Desktop mic/speaker voice interaction

Commands:
  start [--mode=push-to-talk|vad|realtime]   Start continuous voice mode
  stop                                        Stop voice client
  status                                      Check if running
  conversation                                Single conversation turn
  --help                                      Show this help

Modes:
  push-to-talk   Record on hotkey press (default)
  vad            Voice activity detection (always-listening)
  realtime       WebSocket to real-time voice server (port 8882)
                 Falls back to batch pipeline if server unavailable`);
      break;
    }

    case "start": {
      const modeArg = args.find((a) => a.startsWith("--mode="));
      const mode = modeArg ? modeArg.split("=")[1] : undefined;

      if (mode === "realtime") {
        await startRealtime();
      } else {
        await startContinuous(mode as "push-to-talk" | "vad" | undefined);
      }
      break;
    }

    case "stop":
      await stop();
      break;

    case "status":
      await status();
      break;

    case "conversation": {
      const config = getVoiceInteractionConfig();
      const result = await conversationTurn(config);
      // Check for exit in single-turn mode
      if (isExitCommand(result.userSaid)) {
        console.log(JSON.stringify({ ...result, exit: true }, null, 2));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    default:
      console.log(`DesktopVoiceClient - Desktop mic/speaker voice interaction

Commands:
  start [--mode=push-to-talk|vad|realtime]   Start continuous voice mode
  stop                                        Stop voice client
  status                                      Check if running
  conversation                                Single conversation turn`);
      break;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

export { conversationTurn, startContinuous, startRealtime };
export type { ConversationSession, VoiceInteractionConfig as DesktopConfig };
