#!/usr/bin/env bun
/**
 * CanvasUtils — Ecosystem utility functions for Canvas integration
 *
 * Provides:
 * - canvasAvailable(): boolean — checks if Canvas browser is connected to daemon
 *
 * CLI:
 *   bun CanvasUtils.ts available          # prints "true" or "false"
 *   bun CanvasUtils.ts available --json   # prints {"available":true}
 *
 * @module CanvasUtils
 * @version 1.0.0
 */

// ============================================================================
// Types
// ============================================================================

export interface CanvasAvailabilityOptions {
  /** WebSocket URL of the Kaya daemon. Defaults to ws://localhost:18000 */
  daemonUrl?: string;
  /** Timeout in milliseconds. Defaults to 2000 (2 seconds) */
  timeoutMs?: number;
  /** @internal Test hook — inject a mock WebSocket constructor */
  _clientFactory?: (url: string) => WebSocket;
}

// ============================================================================
// canvasAvailable()
// ============================================================================

/**
 * Check if a Canvas browser is connected and responsive via the Kaya daemon.
 *
 * Returns true only if:
 *  1. The daemon WebSocket is reachable
 *  2. Auth handshake succeeds
 *  3. canvas.ping RPC returns within timeout
 *
 * Returns false (never throws) if:
 *  - Daemon is unreachable
 *  - Auth times out
 *  - Ping fails or times out
 *  - Any unexpected error occurs
 *
 * Guaranteed to resolve within timeoutMs (default 2000ms).
 */
export async function canvasAvailable(
  options: CanvasAvailabilityOptions = {}
): Promise<boolean> {
  const { daemonUrl = "ws://localhost:18000", timeoutMs = 2000 } = options;

  return new Promise<boolean>((resolve) => {
    // Master timeout — guarantees we resolve within timeoutMs
    const masterTimeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    let ws: WebSocket | null = null;
    let settled = false;

    function settle(value: boolean): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function cleanup(): void {
      clearTimeout(masterTimeout);
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }
    }

    try {
      ws = options._clientFactory ? options._clientFactory(daemonUrl) : new WebSocket(daemonUrl);
    } catch {
      settle(false);
      return;
    }

    // ── WebSocket event handlers ──

    ws.onopen = () => {
      // Connected. The daemon will send auth.required or auth.success.
      // Send a ping-type auth message (token-free, matching CanvasClient pattern)
      const authMsg = JSON.stringify({
        type: "ping",
        payload: { token: "", timestamp: Date.now() },
      });
      try {
        ws?.send(authMsg);
      } catch {
        settle(false);
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (!parsed || typeof parsed !== "object") return;
      const msg = parsed as Record<string, unknown>;

      // Daemon sends auth.required → we respond (already sent auth on open)
      if (msg["type"] === "auth.required") {
        const authMsg = JSON.stringify({
          type: "ping",
          payload: { token: "", timestamp: Date.now() },
        });
        try {
          ws?.send(authMsg);
        } catch {
          settle(false);
        }
        return;
      }

      // Auth success → send canvas.ping RPC
      if (msg["type"] === "auth.success") {
        const pingMsg = JSON.stringify({
          type: "canvas.rpc",
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "canvas.ping",
            params: {},
          },
        });
        try {
          ws?.send(pingMsg);
        } catch {
          settle(false);
        }
        return;
      }

      // canvas.rpc response
      if (msg["type"] === "canvas.rpc") {
        const payload = msg["payload"] as Record<string, unknown> | undefined;
        if (!payload) return;

        // id=1 response to our canvas.ping
        if (payload["id"] === 1) {
          if ("result" in payload) {
            // Ping succeeded — Canvas is available
            settle(true);
          } else if ("error" in payload) {
            // Ping returned RPC error — no Canvas browser connected
            settle(false);
          }
        }
        return;
      }
    };

    ws.onerror = () => {
      settle(false);
    };

    ws.onclose = () => {
      // If not settled yet, the connection dropped
      settle(false);
    };
  });
}

// ============================================================================
// CLI Interface (Article II compliance)
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [command] = args;
  const jsonFlag = args.includes("--json");

  async function main(): Promise<void> {
    switch (command) {
      case "available": {
        const available = await canvasAvailable();
        if (jsonFlag) {
          console.log(JSON.stringify({ available }));
        } else {
          console.log(String(available));
        }
        break;
      }
      default:
        console.error(
          "Usage: bun CanvasUtils.ts <command> [options]\n" +
          "Commands:\n" +
          "  available        Check if Canvas is connected (prints true/false)\n" +
          "  available --json Print JSON: {\"available\":true}\n"
        );
        process.exit(1);
    }
  }

  main().catch((err) => {
    console.error("[CanvasUtils] Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
