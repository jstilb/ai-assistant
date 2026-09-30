/**
 * RealtimeVoiceServer.test.ts - Tests for the real-time voice WebSocket server
 *
 * Tests cover: server startup, health check, WebSocket lifecycle,
 * full pipeline, interruption, multi-turn context, multi-client isolation,
 * config messages, and edge cases.
 *
 * External services (STT, TTS, Claude API) are mocked via spyOn(globalThis, 'fetch').
 *
 * NOTE: This test runs via `bun test`, NOT vitest. The server uses Bun.serve()
 * which requires the Bun runtime.
 * The original fetch is preserved for test-to-server HTTP calls.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Server } from "bun";

// Preserve original fetch BEFORE any mocking, for test HTTP calls to our server
const originalFetch = globalThis.fetch;

// Pre-existing gap (found while verifying S6, unrelated to it): the server
// requires a `?key=` query param matching VOICE_AUTH_TOKEN on every
// WebSocket upgrade (RealtimeVoiceServer.ts's `authKey !== VOICE_AUTH_TOKEN`
// check), but neither this mock nor connectWs() below supplied one — every
// test failed either at import time ("Export named 'loadSecrets' not
// found", since the mock omitted it entirely) or, once that was fixed, at
// the WS-upgrade step ("Rejected WebSocket — invalid or missing auth key").
// Both reproduced with S6's changes fully reverted (git stash), confirming
// they predate this slice. Fixed here (a shared constant so the mock and
// connectWs() agree) since they blocked verifying this suite stays green
// after S6's CaptureGate mock (below) was added.
const TEST_VOICE_AUTH_TOKEN = "test-voice-auth-token";

// Mock VoiceCommon before importing server
mock.module("../VoiceCommon.ts", () => ({
  KAYA_HOME: "/tmp/test-kaya-home",
  getSecret: mock((key: string) => {
    if (key === "GEMINI_API_KEY") return "test-api-key";
    throw new Error(`Unknown secret: ${key}`);
  }),
  loadSecrets: mock(() => ({ voice_auth_token: TEST_VOICE_AUTH_TOKEN })),
  getIdentity: mock(() => ({
    assistantName: "Kaya",
    userName: "TestUser",
  })),
  getRealtimeVoiceConfig: mock(() => ({
    port: 8882,
    host: "127.0.0.1",
    maxSessions: 5,
    geminiModel: "gemini-2.0-flash",
    llmTimeoutMs: 15000,
    sttUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsUrl: "http://localhost:8880/v1/audio/speech",
    sttHealthUrl: "http://localhost:8881/v1/audio/transcriptions",
    ttsHealthUrl: "http://localhost:8880/v1/models",
    heartbeatIntervalMs: 15000,
    heartbeatMaxMisses: 2,
    memoryWarningMB: 512,
    contextTimeoutMs: 3000,
    macOsSayFallback: false,
    systemPromptTemplatePath: null,
  })),
}));

// Mock ConfigLoader to avoid file system reads in VoiceSystemPrompt
mock.module("../../../../lib/core/ConfigLoader.ts", () => ({
  loadSettings: mock(() => ({
    assistant: { name: "Kaya" },
    user: { name: "TestUser", timezone: "America/Los_Angeles" },
    voice: { defaultVoice: "af_heart" },
  })),
}));

// Mock SentenceChunker to return sentences immediately
mock.module("../SentenceChunker.ts", () => ({
  SentenceChunker: mock().mockImplementation(() => ({
    addToken: mock((token: string) => {
      if (token.includes(".") || token.includes("!") || token.includes("?")) {
        return token;
      }
      return null;
    }),
    flush: mock(() => null),
  })),
}));

// Mock CaptureGate — this suite exercises the STT->LLM->TTS voice pipeline,
// not LifeOS capture routing (that's skills/Productivity/LifeOS/tests/
// capture-gate.test.ts, which calls the real classifier live). Since S6
// ("let the model speak") deleted CaptureGate's code-level heuristic
// pre-filter, every transcript now reaches Router.classify() (a real
// `claude -p` spawn) unless this is mocked — every fixture transcript in
// this file ("Hello Kaya", "Tell me a long story", "First/Second message")
// used to be caught by the old NON_CAPTURE_HEURISTICS/MIN_WORDS gate before
// classify() was ever called, so this mock preserves that "always falls
// through to Claude" behavior without spawning a real classifier process
// per test.
mock.module("../../../../Productivity/LifeOS/Capture/CaptureGate.ts", () => ({
  captureGate: mock(async () => ({
    captured: false,
    bypassReason: "test-mock: voice-server suite does not exercise capture routing",
    latencyMs: 0,
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

function getTestPort(): number {
  return 18000 + Math.floor(Math.random() * 1000);
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?key=${TEST_VOICE_AUTH_TOKEN}`);
    const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };
    ws.onerror = (e) => {
      clearTimeout(timeout);
      reject(e);
    };
  });
}

function waitForMessage(ws: WebSocket, type?: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type ?? "any"}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        if (!type || data.type === type) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // non-JSON message, skip
      }
    };
    ws.addEventListener("message", handler);
  });
}

function collectMessages(ws: WebSocket, durationMs: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const handler = (event: MessageEvent) => {
      try {
        messages.push(JSON.parse(event.data as string) as Record<string, unknown>);
      } catch {
        // binary or non-JSON
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, durationMs);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Fetch Mock Setup
// ============================================================================

const mockFetch = spyOn(globalThis, "fetch");

/**
 * Smart fetch mock that intercepts external service calls but passes through
 * test-to-server calls (localhost on our test port).
 */
function setupFetchMocks(testPort: number): void {
  mockFetch.mockImplementation(async (url, options) => {
    const urlStr = typeof url === "string" ? url : (url as URL).toString();

    // Pass through calls to our test server (health checks, etc.)
    if (urlStr.includes(`localhost:${testPort}`)) {
      return originalFetch(url, options);
    }

    // STT endpoint
    if (urlStr.includes("8881/v1/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: "Hello Kaya" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // TTS endpoint
    if (urlStr.includes("8880/v1/audio/speech") && options?.method === "POST") {
      const fakeWav = new ArrayBuffer(1024);
      return new Response(fakeWav, {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    }

    // Gemini API (streaming SSE)
    if (urlStr.includes("generativelanguage.googleapis.com")) {
      const sseBody = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello!"}],"role":"model"},"finishReason":"STOP"}]}',
        "",
      ].join("\n");
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    // Health check endpoints (for /health tests)
    if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  });
}

function setupFailingHealthMocks(testPort: number): void {
  mockFetch.mockImplementation(async (url, options) => {
    const urlStr = typeof url === "string" ? url : (url as URL).toString();

    // Pass through calls to our test server
    if (urlStr.includes(`localhost:${testPort}`)) {
      return originalFetch(url, options);
    }

    if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
      throw new Error("Connection refused");
    }

    return new Response("Not Found", { status: 404 });
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("RealtimeVoiceServer", () => {
  let server: Server | undefined;
  let port: number;
  let openSockets: WebSocket[] = [];

  // Dynamic import to get the module after mocks are set up
  let startServer: (port?: number) => Server;
  let sessions: Map<unknown, unknown>;
  let sessionStore: Map<string, { session: unknown; disconnectedAt: number | null }>;
  let SESSION_RECOVERY_TTL_MS: number;

  beforeEach(async () => {
    port = getTestPort();
    mockFetch.mockReset();
    setupFetchMocks(port);

    const mod = await import("../RealtimeVoiceServer.ts");
    startServer = mod.startServer;
    sessions = mod.sessions;
    sessionStore = mod.sessionStore as Map<string, { session: unknown; disconnectedAt: number | null }>;
    SESSION_RECOVERY_TTL_MS = mod.SESSION_RECOVERY_TTL_MS;

    // Clear sessions and session store from prior tests
    sessions.clear();
    sessionStore.clear();
    openSockets = [];
  });

  afterEach(async () => {
    // Close all open WebSocket connections
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets = [];

    // Stop server
    if (server) {
      server.stop(true);
      server = undefined;
    }
    await delay(50);
  });

  // ========================================================================
  // Server startup
  // ========================================================================

  describe("Server startup", () => {
    it("should start on specified port", async () => {
      server = startServer(port);
      expect(server).toBeDefined();
      expect(server.port).toBe(port);
    });

    it("should respond to HTTP requests after starting", async () => {
      server = startServer(port);
      const response = await originalFetch(`http://localhost:${port}/health`);
      expect(response.ok).toBe(true);
    });
  });

  // ========================================================================
  // Health check
  // ========================================================================

  describe("Health check", () => {
    it("should return health status JSON", async () => {
      server = startServer(port);
      // Use passthrough fetch for our test server -- mock handles external service calls
      const response = await originalFetch(`http://localhost:${port}/health`);
      expect(response.ok).toBe(true);

      const health = (await response.json()) as Record<string, unknown>;
      expect(health).toHaveProperty("status");
      expect(health).toHaveProperty("activeSessions");
      expect(health).toHaveProperty("services");
      expect(health).toHaveProperty("uptime");
      expect(health).toHaveProperty("timestamp");
    });

    it("should report healthy when all services are up", async () => {
      server = startServer(port);
      const response = await originalFetch(`http://localhost:${port}/health`);
      const health = (await response.json()) as Record<string, unknown>;
      expect(health.status).toBe("healthy");
    });

    it("should report unhealthy when STT service is down", async () => {
      setupFailingHealthMocks(port);
      server = startServer(port);
      const response = await originalFetch(`http://localhost:${port}/health`);
      const health = (await response.json()) as Record<string, unknown>;
      // STT unavailable = unhealthy (server can't transcribe audio)
      expect(health.status).toBe("unhealthy");
    });
  });

  // ========================================================================
  // WebSocket connection
  // ========================================================================

  describe("WebSocket connection", () => {
    it("should create session on connect", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      const msg = await waitForMessage(ws, "status");
      expect(msg.state).toBe("listening");
      expect(sessions.size).toBe(1);
    });

    it("should clean up session on disconnect", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");
      expect(sessions.size).toBe(1);

      ws.close();
      await delay(200);
      expect(sessions.size).toBe(0);
    });
  });

  // ========================================================================
  // Full voice pipeline
  // ========================================================================

  describe("Full voice pipeline", () => {
    it("should process audio through STT -> LLM -> TTS -> client", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      // Wait for initial status:listening
      await waitForMessage(ws, "status");

      // Collect all messages over the next few seconds
      const messagesPromise = collectMessages(ws, 3000);

      // Send binary audio data (fake WAV)
      const fakeAudio = new ArrayBuffer(512);
      ws.send(fakeAudio);

      const messages = await messagesPromise;
      const types = messages.map((m) => m.type);

      // Should see: status(thinking), transcript, audio or response_text
      expect(types).toContain("status");
      expect(types).toContain("transcript");

      // Verify transcript content
      const transcript = messages.find((m) => m.type === "transcript");
      expect(transcript?.text).toBe("Hello Kaya");

      // Should have a thinking status
      const thinkingStatus = messages.find((m) => m.type === "status" && m.state === "thinking");
      expect(thinkingStatus).toBeDefined();
    });
  });

  // ========================================================================
  // Interruption
  // ========================================================================

  describe("Interruption", () => {
    it("should abort generation on interrupt message", async () => {
      // Slow down Claude response to give time for interrupt
      mockFetch.mockImplementation(async (url, options) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();

        // Pass through test server calls
        if (urlStr.includes(`localhost:${port}`)) {
          return originalFetch(url, options);
        }

        if (urlStr.includes("8881/v1/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: "Tell me a long story" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (urlStr.includes("generativelanguage.googleapis.com")) {
          // Slow Gemini SSE stream
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 20; i++) {
                await delay(100);
                controller.enqueue(
                  encoder.encode(
                    `data: {"candidates":[{"content":{"parts":[{"text":"word ${i}. "}],"role":"model"}}]}\n\n`,
                  ),
                );
              }
              controller.enqueue(
                encoder.encode(
                  'data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP"}]}\n\n',
                ),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (urlStr.includes("8880/v1/audio/speech") && options?.method === "POST") {
          return new Response(new ArrayBuffer(512), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }

        if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
          return new Response("ok", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
      });

      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      // Send audio to start processing
      ws.send(new ArrayBuffer(512));

      // Wait for thinking status
      await waitForMessage(ws, "status");
      await delay(200);

      // Send interrupt
      ws.send(JSON.stringify({ type: "interrupt" }));

      // Should get status:listening after interrupt
      const statusMsg = await waitForMessage(ws, "status");
      expect(statusMsg.state).toBe("listening");
    });
  });

  // ========================================================================
  // Conversation context
  // ========================================================================

  describe("Conversation context", () => {
    it("should retain multi-turn history", async () => {
      let callCount = 0;
      let lastGeminiBody: Record<string, unknown> | null = null;

      mockFetch.mockImplementation(async (url, options) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();

        // Pass through test server calls
        if (urlStr.includes(`localhost:${port}`)) {
          return originalFetch(url, options);
        }

        if (urlStr.includes("8881/v1/audio/transcriptions")) {
          callCount++;
          const text = callCount === 1 ? "First message" : "Second message";
          return new Response(JSON.stringify({ text }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (urlStr.includes("generativelanguage.googleapis.com")) {
          if (options?.body) {
            lastGeminiBody = JSON.parse(options.body as string) as Record<string, unknown>;
          }
          const sseBody = 'data: {"candidates":[{"content":{"parts":[{"text":"Reply."}],"role":"model"},"finishReason":"STOP"}]}\n\n';
          return new Response(sseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (urlStr.includes("8880/v1/audio/speech") && options?.method === "POST") {
          return new Response(new ArrayBuffer(512), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }

        if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
          return new Response("ok", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
      });

      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      // First turn
      ws.send(new ArrayBuffer(512));
      // Wait for the full pipeline to complete (back to listening)
      await delay(1500);

      // Ensure we're back to listening before sending second turn
      // Wait beyond rate limit (500ms)
      await delay(600);

      // Second turn
      ws.send(new ArrayBuffer(512));
      await delay(1500);

      // The second Gemini API call should include the first exchange
      expect(lastGeminiBody).not.toBeNull();
      const contents = lastGeminiBody!.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
      expect(contents.length).toBeGreaterThanOrEqual(2);

      // First exchange should be in history (Gemini uses "user"/"model" roles)
      const userMessages = contents.filter((m) => m.role === "user");
      expect(userMessages.length).toBe(2);
      expect(userMessages[0].parts[0].text).toBe("First message");
      expect(userMessages[1].parts[0].text).toBe("Second message");
    });
  });

  // ========================================================================
  // Multi-client isolation
  // ========================================================================

  describe("Multi-client isolation", () => {
    it("should maintain independent sessions per client", async () => {
      server = startServer(port);

      // Connect first client and wait for its status
      const ws1 = await connectWs(port);
      openSockets.push(ws1);
      await waitForMessage(ws1, "status");

      // Connect second client and wait for its status
      const ws2 = await connectWs(port);
      openSockets.push(ws2);
      await waitForMessage(ws2, "status");

      expect(sessions.size).toBe(2);

      // Disconnect one client
      ws1.close();
      await delay(200);

      expect(sessions.size).toBe(1);
    });
  });

  // ========================================================================
  // Config message
  // ========================================================================

  describe("Config message", () => {
    it("should update session config", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      // Send config update
      ws.send(
        JSON.stringify({
          type: "config",
          voice: "bf_emma",
          maxTokens: 2048,
          maxTurns: 100,
        }),
      );

      await delay(200);

      // Verify session config was updated
      const sessionValues = Array.from(sessions.values()) as Array<{
        config: { voice: string; maxTokens: number };
        maxTurns: number;
      }>;
      expect(sessionValues.length).toBe(1);
      expect(sessionValues[0].config.voice).toBe("bf_emma");
      expect(sessionValues[0].config.maxTokens).toBe(2048);
      expect(sessionValues[0].maxTurns).toBe(100);
    });
  });

  // ========================================================================
  // Phase 4: Session acknowledgment
  // ========================================================================

  describe("Session acknowledgment", () => {
    it("should send session_ack on fresh connection", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      const ack = await waitForMessage(ws, "session_ack");
      expect(ack.resumed).toBe(false);
      expect(ack.conversationLength).toBe(0);
      expect(typeof ack.sessionId).toBe("string");
      expect((ack.sessionId as string).length).toBeGreaterThan(0);
    });

    it("should send session_ack with resumed:false for unknown sessionId", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      // Wait for initial messages
      await waitForMessage(ws, "status");
      await waitForMessage(ws, "session_ack");

      // Send session_init with a nonexistent sessionId
      ws.send(JSON.stringify({ type: "session_init", sessionId: "nonexistent-id" }));

      const ack = await waitForMessage(ws, "session_ack");
      expect(ack.resumed).toBe(false);
    });
  });

  // ========================================================================
  // Phase 4: Text input pipeline
  // ========================================================================

  describe("Text input pipeline", () => {
    it("should process text through LLM -> TTS without STT", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      const messagesPromise = collectMessages(ws, 3000);

      // Send text message (bypasses STT)
      ws.send(JSON.stringify({ type: "text", text: "Hello Kaya" }));

      const messages = await messagesPromise;
      const types = messages.map((m) => m.type);

      // Should see transcript echo of the text input
      expect(types).toContain("transcript");
      const transcript = messages.find((m) => m.type === "transcript");
      expect(transcript?.text).toBe("Hello Kaya");

      // Should go through thinking status
      const thinkingStatus = messages.find((m) => m.type === "status" && m.state === "thinking");
      expect(thinkingStatus).toBeDefined();

      // Should eventually return to listening
      const finalStatus = messages.filter((m) => m.type === "status").pop();
      expect(finalStatus?.state).toBe("listening");
    });
  });

  // ========================================================================
  // Phase 4: Session recovery
  // ========================================================================

  describe("Session recovery", () => {
    it("should recover session with conversation history", async () => {
      server = startServer(port);

      // Connect client A
      const wsA = await connectWs(port);
      openSockets.push(wsA);

      await waitForMessage(wsA, "status");
      const ackA = await waitForMessage(wsA, "session_ack");
      const savedSessionId = ackA.sessionId as string;

      // Build conversation history via audio pipeline
      const messagesPromise = collectMessages(wsA, 3000);
      wsA.send(new ArrayBuffer(512));
      await messagesPromise;

      // Wait for pipeline to complete
      await delay(500);

      // Disconnect client A
      wsA.close();
      await delay(200);

      // Connect client B and request session recovery
      const wsB = await connectWs(port);
      openSockets.push(wsB);

      // Consume initial status and ack from fresh connect
      await waitForMessage(wsB, "status");
      await waitForMessage(wsB, "session_ack");

      // Request recovery
      wsB.send(JSON.stringify({ type: "session_init", sessionId: savedSessionId }));

      const ackB = await waitForMessage(wsB, "session_ack");
      expect(ackB.resumed).toBe(true);
      expect(ackB.sessionId).toBe(savedSessionId);
      expect((ackB.conversationLength as number)).toBeGreaterThan(0);
    });

    it("should fail recovery for expired session", async () => {
      server = startServer(port);

      // Connect and get sessionId
      const wsA = await connectWs(port);
      openSockets.push(wsA);
      await waitForMessage(wsA, "status");
      const ackA = await waitForMessage(wsA, "session_ack");
      const savedSessionId = ackA.sessionId as string;

      // Disconnect
      wsA.close();
      await delay(200);

      // Manually expire the session in the store
      const stored = sessionStore.get(savedSessionId);
      expect(stored).toBeDefined();
      stored!.disconnectedAt = Date.now() - SESSION_RECOVERY_TTL_MS - 1000;

      // Connect new client and try recovery
      const wsB = await connectWs(port);
      openSockets.push(wsB);

      await waitForMessage(wsB, "status");
      await waitForMessage(wsB, "session_ack");

      wsB.send(JSON.stringify({ type: "session_init", sessionId: savedSessionId }));

      const ackB = await waitForMessage(wsB, "session_ack");
      expect(ackB.resumed).toBe(false);
    });
  });

  // ========================================================================
  // Phase 4: Session store cleanup
  // ========================================================================

  describe("Session store lifecycle", () => {
    it("should store session on connect and mark disconnected on close", async () => {
      server = startServer(port);

      const ws = await connectWs(port);
      openSockets.push(ws);
      await waitForMessage(ws, "status");
      const ack = await waitForMessage(ws, "session_ack");
      const sessionId = ack.sessionId as string;

      // Session should be in store with null disconnectedAt
      const stored = sessionStore.get(sessionId);
      expect(stored).toBeDefined();
      expect(stored!.disconnectedAt).toBeNull();

      // Disconnect
      ws.close();
      await delay(200);

      // Session should be in store with non-null disconnectedAt
      const storedAfter = sessionStore.get(sessionId);
      expect(storedAfter).toBeDefined();
      expect(storedAfter!.disconnectedAt).not.toBeNull();
      expect(typeof storedAfter!.disconnectedAt).toBe("number");
    });

    it("should not contain sessions removed by cleanup", () => {
      // Manually add an expired entry
      const expiredId = "test-expired-session";
      sessionStore.set(expiredId, {
        session: { id: expiredId } as unknown,
        disconnectedAt: Date.now() - SESSION_RECOVERY_TTL_MS - 10000,
      });

      // Manually run cleanup logic (same as the interval)
      const now = Date.now();
      for (const [id, entry] of sessionStore) {
        if (entry.disconnectedAt !== null && now - entry.disconnectedAt > SESSION_RECOVERY_TTL_MS) {
          sessionStore.delete(id);
        }
      }

      expect(sessionStore.has(expiredId)).toBe(false);
    });
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  describe("Edge cases", () => {
    it("should handle empty transcription gracefully", async () => {
      mockFetch.mockImplementation(async (url, options) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();

        if (urlStr.includes(`localhost:${port}`)) {
          return originalFetch(url, options);
        }

        if (urlStr.includes("8881/v1/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
          return new Response("ok", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
      });

      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      const messagesPromise = collectMessages(ws, 1500);
      ws.send(new ArrayBuffer(512));
      const messages = await messagesPromise;

      // Should return to listening without sending transcript or response
      const transcript = messages.find((m) => m.type === "transcript");
      expect(transcript).toBeUndefined();

      // Should eventually go back to listening
      const finalStatus = messages.filter((m) => m.type === "status").pop();
      expect(finalStatus?.state).toBe("listening");
    });

    it("should handle rate limiting", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      const messagesPromise = collectMessages(ws, 1500);

      // Send two audio messages rapidly (within 500ms rate limit)
      ws.send(new ArrayBuffer(512));
      ws.send(new ArrayBuffer(512));

      const messages = await messagesPromise;
      const errors = messages.filter((m) => m.type === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(String(errors[0].message)).toContain("Rate limited");
    });

    it("should handle malformed JSON", async () => {
      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      const msgPromise = waitForMessage(ws, "error");
      ws.send("not valid json {{{");

      const errorMsg = await msgPromise;
      expect(errorMsg.type).toBe("error");
      expect(String(errorMsg.message)).toContain("parse");
    });

    it("should return 404 for unknown paths", async () => {
      server = startServer(port);
      const response = await originalFetch(`http://localhost:${port}/unknown-path`);
      expect(response.status).toBe(404);
    });

    it("should handle STT service failure", async () => {
      mockFetch.mockImplementation(async (url, options) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();

        if (urlStr.includes(`localhost:${port}`)) {
          return originalFetch(url, options);
        }

        if (urlStr.includes("8881/v1/audio/transcriptions")) {
          throw new Error("Connection refused");
        }

        if (urlStr.includes("8881/v1/models") || urlStr.includes("8880/v1/models")) {
          return new Response("ok", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
      });

      server = startServer(port);
      const ws = await connectWs(port);
      openSockets.push(ws);

      await waitForMessage(ws, "status");

      const messagesPromise = collectMessages(ws, 2000);
      ws.send(new ArrayBuffer(512));
      const messages = await messagesPromise;

      // Should get an error about STT
      const errors = messages.filter((m) => m.type === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);

      // Should return to listening
      const finalStatus = messages.filter((m) => m.type === "status").pop();
      expect(finalStatus?.state).toBe("listening");
    });
  });
});
