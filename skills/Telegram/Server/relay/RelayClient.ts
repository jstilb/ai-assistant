#!/usr/bin/env bun
/**
 * RelayClient.ts - Desktop daemon connecting to Cloudflare Workers relay
 *
 * This daemon:
 * 1. Establishes persistent WebSocket connection to the relay server
 * 2. Decrypts incoming frames using NaCl box (shared key from pairing)
 * 3. Routes decrypted messages through RelayGateway → KayaMobileGateway pipeline
 * 4. Encrypts responses and sends back via relay
 * 5. Auto-reconnects on disconnect with exponential backoff
 *
 * Usage:
 *   bun RelayClient.ts              - Start daemon
 *   bun RelayClient.ts pair         - Generate pairing code and wait
 *   bun RelayClient.ts status       - Check connection status
 *   bun RelayClient.ts notify "msg" - Send push notification to mobile
 *
 * Runs as a launchd daemon on macOS (persistent WebSocket listener).
 */

import { WebSocket } from "ws";
import { loadRelayConfig, saveRelayConfig, validateRelayConfig, getRelayUrl } from "./RelayConfig";
import { RelayGateway } from "./RelayGateway";
import type { RelayFrame } from "./types/relay";

// NaCl box for E2E encryption
// Using tweetnacl-compatible API (install: bun add tweetnacl)
// For type safety without importing the actual package at compile time:
interface NaCl {
  box: {
    keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
    before(theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array;
    after(message: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array;
    open: {
      after(box: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array | null;
    };
  };
  randomBytes(n: number): Uint8Array;
}

// Connection state
let ws: WebSocket | null = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let gateway: RelayGateway | null = null;
let sharedKey: Uint8Array | null = null;

const MAX_RECONNECT_DELAY_MS = 30000;
const BASE_RECONNECT_DELAY_MS = 1000;

// ─────────────────────────────────────────────────────────
// Encryption Helpers
// ─────────────────────────────────────────────────────────

function loadNaCl(): NaCl {
  // Dynamic import to avoid breaking if tweetnacl is not installed during type-check
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("tweetnacl") as NaCl;
  } catch {
    throw new Error(
      "tweetnacl not installed. Run: bun add tweetnacl"
    );
  }
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function encryptPayload(
  payload: unknown,
  key: Uint8Array
): { encrypted: string; nonce: string } {
  const nacl = loadNaCl();
  const nonce = nacl.randomBytes(24);
  const messageBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = nacl.box.after(messageBytes, nonce, key);

  return {
    encrypted: base64urlEncode(encrypted),
    nonce: base64urlEncode(nonce),
  };
}

function decryptPayload<T>(
  encrypted: string,
  nonce: string,
  key: Uint8Array
): T {
  const nacl = loadNaCl();
  const encBytes = base64urlDecode(encrypted);
  const nonceBytes = base64urlDecode(nonce);
  const decrypted = nacl.box.open.after(encBytes, nonceBytes, key);

  if (!decrypted) {
    throw new Error("Decryption failed — invalid ciphertext or wrong key");
  }

  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

// ─────────────────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  const config = await loadRelayConfig();

  if (!validateRelayConfig(config)) {
    console.error(
      "[RelayClient] Not paired. Run: bun RelayClient.ts pair"
    );
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const wsUrl = `${relayUrl}/ws?role=desktop&deviceId=${config.device_id}&token=${config.session_token}`;

  sharedKey = base64urlDecode(config.shared_key);

  // Initialize gateway with encrypt/decrypt callbacks
  gateway = new RelayGateway(
    (frame: RelayFrame) => {
      if (ws && isConnected) {
        ws.send(JSON.stringify(frame));
      } else {
        console.warn("[RelayClient] Cannot send — not connected");
      }
    },
    (payload: unknown) => encryptPayload(payload, sharedKey!),
    <T>(encrypted: string, nonce: string) => decryptPayload<T>(encrypted, nonce, sharedKey!)
  );

  console.log(`[RelayClient] Connecting to ${relayUrl}...`);

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    isConnected = true;
    reconnectAttempts = 0;
    console.log("[RelayClient] Connected to relay");

    // Start heartbeat
    startHeartbeat();
  });

  ws.on("message", async (data: Buffer | string) => {
    try {
      const frame = JSON.parse(
        typeof data === "string" ? data : data.toString()
      ) as RelayFrame & { relayStatus?: string };

      // Handle relay-level status (not encrypted)
      if (frame.type === "status" && frame.relayStatus) {
        handleRelayStatus(frame.relayStatus);
        return;
      }

      // Handle pong
      if (frame.type === "pong") {
        return;
      }

      // Route message frames through gateway pipeline
      if (
        frame.type === "message" ||
        frame.type === "voice_chunk" ||
        frame.type === "interrupt"
      ) {
        await gateway!.processMessageFrame(frame);
      }
    } catch (error) {
      console.error("[RelayClient] Error processing message:", error);
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    isConnected = false;
    console.log(
      `[RelayClient] Disconnected (code=${code}, reason=${reason.toString()})`
    );
    scheduleReconnect();
  });

  ws.on("error", (error: Error) => {
    console.error("[RelayClient] WebSocket error:", error.message);
    isConnected = false;
  });
}

function handleRelayStatus(status: string): void {
  switch (status) {
    case "desktop_connected":
      console.log("[RelayClient] Relay confirmed desktop connection");
      break;
    case "rate_limited":
      console.warn("[RelayClient] Rate limited by relay");
      break;
    case "error":
      console.error("[RelayClient] Relay error");
      break;
    default:
      console.log(`[RelayClient] Relay status: ${status}`);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS
  );

  reconnectAttempts++;
  console.log(
    `[RelayClient] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`
  );

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connect();
  }, delay);
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  heartbeatInterval = setInterval(() => {
    if (ws && isConnected) {
      const pingFrame: RelayFrame = {
        type: "ping",
        id: `ping-${Date.now()}`,
        encrypted: "",
        nonce: "",
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(pingFrame));
    }
  }, 30000); // Ping every 30 seconds
}

// ─────────────────────────────────────────────────────────
// Pairing Flow
// ─────────────────────────────────────────────────────────

async function pair(): Promise<void> {
  const nacl = loadNaCl();
  const config = await loadRelayConfig();
  const relayUrl = getRelayUrl(config);
  const httpUrl = relayUrl.replace("wss://", "https://").replace("ws://", "http://");

  console.log("[RelayClient] Starting pairing flow...");

  // Generate key pair for this desktop
  const keyPair = nacl.box.keyPair();
  const publicKeyB64 = base64urlEncode(keyPair.publicKey);
  const secretKeyB64 = base64urlEncode(keyPair.secretKey);

  // Request pairing code from relay
  const genResp = await fetch(`${httpUrl}/pair/generate`, { method: "POST" });
  const { code, qrPayload, expiresInSeconds } = (await genResp.json()) as {
    code: string;
    qrPayload: string;
    expiresInSeconds: number;
  };

  // Register our public key with relay
  await fetch(`${httpUrl}/pair/desktop-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, desktopPublicKey: publicKeyB64 }),
  });

  console.log("\n================================");
  console.log("KAYA RELAY PAIRING");
  console.log("================================");
  console.log(`Pairing Code: ${code}`);
  console.log(`Expires in: ${expiresInSeconds}s`);
  console.log("\nQR Code Payload (encode this as QR in your app):");
  console.log(qrPayload);
  console.log("================================\n");
  console.log("Waiting for mobile to pair...");

  // Poll for pairing status
  const pollInterval = setInterval(async () => {
    try {
      const statusResp = await fetch(`${httpUrl}/pair/status/${code}`);
      if (!statusResp.ok) {
        clearInterval(pollInterval);
        console.error("[RelayClient] Pairing code expired or invalid");
        process.exit(1);
        return;
      }

      const status = (await statusResp.json()) as {
        state: string;
        hasMobileKey: boolean;
        deviceName?: string;
      };

      if (status.state === "mobile_connected" && status.hasMobileKey) {
        clearInterval(pollInterval);
        console.log(
          `[RelayClient] Mobile connected! Device: ${status.deviceName ?? "unknown"}`
        );

        // Get mobile's public key from relay
        const connectResp = await fetch(`${httpUrl}/pair/status/${code}`);
        const connectData = (await connectResp.json()) as {
          mobilePublicKey?: string;
        };

        if (!connectData.mobilePublicKey) {
          console.error("[RelayClient] Failed to get mobile public key");
          process.exit(1);
          return;
        }

        // Derive shared key
        const mobilePublicKey = base64urlDecode(connectData.mobilePublicKey);
        const computedSharedKey = nacl.box.before(mobilePublicKey, keyPair.secretKey);
        const sharedKeyB64 = base64urlEncode(computedSharedKey);

        // Generate device ID
        const deviceId = `kaya-${Date.now().toString(36)}`;

        // Generate session token
        const tokenBytes = nacl.randomBytes(32);
        const sessionToken = base64urlEncode(tokenBytes);

        // Confirm pairing
        await fetch(`${httpUrl}/pair/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, deviceId }),
        });

        // Save config
        await saveRelayConfig({
          relay_url: relayUrl,
          device_id: deviceId,
          session_token: sessionToken,
          shared_key: sharedKeyB64,
          device_public: publicKeyB64,
          device_secret: secretKeyB64,
        });

        console.log("[RelayClient] Pairing complete!");
        console.log(`Device ID: ${deviceId}`);
        console.log("Run: bun RelayClient.ts  — to start the daemon");
        process.exit(0);
      }
    } catch (error) {
      console.error("[RelayClient] Poll error:", error);
    }
  }, 2000);

  // Timeout after pairing expires
  setTimeout(() => {
    clearInterval(pollInterval);
    console.error("[RelayClient] Pairing timed out");
    process.exit(1);
  }, (expiresInSeconds + 5) * 1000);
}

// ─────────────────────────────────────────────────────────
// Send Notification (from desktop to mobile via relay)
// ─────────────────────────────────────────────────────────

async function sendNotification(message: string): Promise<void> {
  const config = await loadRelayConfig();
  if (!validateRelayConfig(config)) {
    console.error("[RelayClient] Not paired");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  const httpUrl = relayUrl.replace("wss://", "https://").replace("ws://", "http://");
  const key = base64urlDecode(config.shared_key);

  const payload = {
    title: "Kaya",
    body: message,
    category: "alert",
    urgent: false,
  };

  const { encrypted, nonce } = encryptPayload(payload, key);

  const resp = await fetch(`${httpUrl}/push/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: config.device_id,
      encryptedBody: encrypted,
      nonce,
      title: "Kaya",
      category: "alert",
      urgent: false,
    }),
  });

  if (resp.ok) {
    console.log("[RelayClient] Notification sent");
  } else {
    console.error("[RelayClient] Failed to send notification:", await resp.text());
  }
}

// ─────────────────────────────────────────────────────────
// Status Check
// ─────────────────────────────────────────────────────────

async function checkStatus(): Promise<void> {
  const config = await loadRelayConfig();
  if (!validateRelayConfig(config)) {
    console.log("Status: NOT PAIRED");
    return;
  }

  const relayUrl = getRelayUrl(config);
  const httpUrl = relayUrl.replace("wss://", "https://").replace("ws://", "http://");

  try {
    const resp = await fetch(`${httpUrl}/session/status/${config.device_id}`);
    if (resp.ok) {
      const status = await resp.json();
      console.log("Relay Status:", JSON.stringify(status, null, 2));
    } else {
      console.log("Status: Relay unreachable");
    }
  } catch {
    console.log("Status: Cannot reach relay");
  }
}

// ─────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "pair":
      await pair();
      break;

    case "status":
      await checkStatus();
      break;

    case "notify": {
      const message = process.argv[3];
      if (!message) {
        console.error("Usage: bun RelayClient.ts notify <message>");
        process.exit(1);
      }
      await sendNotification(message);
      break;
    }

    default:
      // Start daemon
      console.log("[RelayClient] Starting Kaya Relay Client daemon...");
      await connect();

      // Graceful shutdown
      process.on("SIGINT", () => {
        console.log("\n[RelayClient] Shutting down...");
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, "Shutdown");
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        console.log("\n[RelayClient] Shutting down...");
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, "Shutdown");
        process.exit(0);
      });

      console.log("[RelayClient] Daemon started. Press Ctrl+C to stop.");
  }
}

main().catch((error: Error) => {
  console.error("[RelayClient] Fatal error:", error.message);
  process.exit(1);
});
