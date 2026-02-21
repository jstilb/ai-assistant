/**
 * TelegramConfig.ts - Shared configuration module for Telegram skill
 *
 * Single source of truth for bot token, chat ID, and settings.
 * Used by both TelegramClient.ts (outbound) and TelegramBot.ts (inbound).
 */

const KAYA_HOME = process.env.HOME + "/.claude";

export interface TelegramSecrets {
  bot_token: string;
  chat_id: string;
}

export interface TelegramSettings {
  daidentity?: {
    name?: string;
    fullName?: string;
  };
  principal?: {
    name?: string;
    timezone?: string;
  };
}

/**
 * Load Telegram secrets (bot token + chat ID) from secrets.json
 *
 * Exits with helpful error messages if required fields are missing.
 */
export async function loadTelegramSecrets(opts?: {
  requireChatId?: boolean;
}): Promise<TelegramSecrets> {
  const secretsPath = `${KAYA_HOME}/secrets.json`;
  const secrets = await Bun.file(secretsPath).json();

  if (!secrets.telegram?.bot_token) {
    console.error("Error: telegram.bot_token not found in secrets.json");
    console.error("\nSetup instructions:");
    console.error("1. Message @BotFather on Telegram");
    console.error("2. Send /newbot and follow prompts");
    console.error("3. Add to secrets.json:");
    console.error('   "telegram": {');
    console.error('     "bot_token": "YOUR_BOT_TOKEN",');
    console.error('     "chat_id": "YOUR_CHAT_ID"');
    console.error("   }");
    process.exit(1);
  }

  if (opts?.requireChatId && !secrets.telegram?.chat_id) {
    console.error("Error: telegram.chat_id not found in secrets.json");
    console.error("Run: bun TelegramClient.ts get-chat-id");
    process.exit(1);
  }

  return secrets.telegram;
}

/**
 * Load Kaya settings (identity, principal, timezone)
 */
export async function loadTelegramSettings(): Promise<TelegramSettings> {
  const settingsPath = `${KAYA_HOME}/settings.json`;
  return await Bun.file(settingsPath).json();
}

/**
 * Get the principal's timezone from settings, with fallback
 */
export async function getTimezone(): Promise<string> {
  const settings = await loadTelegramSettings();
  return settings.principal?.timezone || "America/Los_Angeles";
}
