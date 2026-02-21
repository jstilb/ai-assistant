/**
 * RelayConfig.ts - Configuration for the desktop relay client
 *
 * Loads relay settings from ~/.claude/secrets.json.
 * Keys stored under "relay" namespace:
 *   relay_url      - WSS URL of Cloudflare Workers relay
 *   device_id      - Paired device ID (set after pairing)
 *   session_token  - Auth token for relay (set after pairing)
 *   shared_key     - Base64url NaCl shared secret (set after pairing)
 *   device_public  - Desktop's Curve25519 public key (base64url)
 *   device_secret  - Desktop's Curve25519 secret key (base64url)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const SECRETS_PATH = join(process.env.HOME ?? "~", ".claude", "secrets.json");

export interface RelaySecrets {
  relay_url: string;
  device_id: string;
  session_token: string;
  /** Base64url-encoded NaCl shared secret */
  shared_key: string;
  /** Base64url-encoded Curve25519 public key */
  device_public: string;
  /** Base64url-encoded Curve25519 secret key */
  device_secret: string;
}

export interface RelayConfig {
  relay: Partial<RelaySecrets>;
}

/**
 * Load relay configuration from secrets.json
 */
export async function loadRelayConfig(): Promise<Partial<RelaySecrets>> {
  if (!existsSync(SECRETS_PATH)) {
    return {};
  }

  try {
    const content = await readFile(SECRETS_PATH, "utf-8");
    const secrets = JSON.parse(content) as Record<string, unknown>;
    const relay = secrets["relay"] as Partial<RelaySecrets> | undefined;
    return relay ?? {};
  } catch {
    return {};
  }
}

/**
 * Save relay configuration to secrets.json
 */
export async function saveRelayConfig(
  config: Partial<RelaySecrets>
): Promise<void> {
  let existing: Record<string, unknown> = {};

  if (existsSync(SECRETS_PATH)) {
    try {
      const content = await readFile(SECRETS_PATH, "utf-8");
      existing = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Start fresh if parse fails
    }
  }

  existing["relay"] = {
    ...(existing["relay"] as Partial<RelaySecrets> ?? {}),
    ...config,
  };

  await writeFile(SECRETS_PATH, JSON.stringify(existing, null, 2));
}

/**
 * Validate that all required relay config is present for connecting
 */
export function validateRelayConfig(
  config: Partial<RelaySecrets>
): config is RelaySecrets {
  return !!(
    config.relay_url &&
    config.device_id &&
    config.session_token &&
    config.shared_key &&
    config.device_public &&
    config.device_secret
  );
}

/**
 * Get the relay URL with fallback
 */
export function getRelayUrl(config: Partial<RelaySecrets>): string {
  return (
    config.relay_url ??
    process.env["KAYA_RELAY_URL"] ??
    "wss://kaya-relay.your-subdomain.workers.dev"
  );
}
