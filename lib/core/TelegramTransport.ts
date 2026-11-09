/**
 * TelegramTransport.ts — the one push HTTP call to the Telegram Bot API (ADR-036).
 *
 * Both ADR-004 lanes deliver through `telegramCall`: Lane 1 (NotificationService)
 * and Lane 2 (TelegramClient). The lanes keep their own policy (chunking,
 * escaping, truncation, the outbound ledger). This module hides:
 *
 *   1. the push switch — a `send*` method with the switch off is `suppressed`
 *      before any credential read or fetch; other methods (`getUpdates`) are not gated;
 *   2. credentials — `telegram.bot_token` / `telegram.chat_id` via lib/core/Secrets.ts;
 *      any SecretError becomes a `config` error; a `send*` without a chat_id is a `config` error;
 *   3. Jm's chat — `send*` always goes to the configured chat_id; a caller chat_id is a `config` error;
 *   4. the body — any Blob param → multipart, else JSON; rebuilt for each attempt;
 *   5. a timeout per attempt (default 15 000 ms) → `timeout` error;
 *   6. HTTP 429 → wait `retry_after` s (default 5), one more attempt; a second 429 → `rejected`;
 *   7. a non-JSON body or no boolean `ok` → `bad-response` error;
 *   8. token-free errors — messages are built from method + status + description,
 *      network text goes through redactSecrets, the original error is never attached.
 *
 * Port: `globalThis.fetch`, read on every call. Prod adapter = Bun fetch; test
 * adapter = lib/core/FakeTelegram.ts (`install()` swaps it). Bot replies (telegraf,
 * explicit chat) never use this module.
 */

import { isTelegramPushEnabled } from "./TelegramOutboundLedger.ts";
import { optionalSecret, requireSecret, SecretError } from "./Secrets.ts";
import { redactSecrets } from "./Redactor.ts";

export interface TelegramCredentials {
  botToken: string;
  chatId: string | null;
}

export type TelegramParams = Record<string, string | number | boolean | Blob | object | undefined>;

export type TelegramOutcome<T = unknown> =
  | { status: "ok"; result: T; messageId: number | null }
  | { status: "suppressed" }
  | { status: "rejected"; httpStatus: number; description: string };

export type TelegramTransportErrorKind = "config" | "network" | "timeout" | "bad-response";

export class TelegramTransportError extends Error {
  readonly kind: TelegramTransportErrorKind;
  readonly method: string;

  /** `message` must never contain the bot token. */
  constructor(kind: TelegramTransportErrorKind, method: string, message: string) {
    super(`Telegram ${method} (${kind}): ${message}`);
    this.name = "TelegramTransportError";
    this.kind = kind;
    this.method = method;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_S = 5;

const BOTFATHER_HINT = [
  "Setup: 1. Message @BotFather on Telegram.",
  "2. Send /newbot and follow the prompts.",
  '3. Add to secrets.json: "telegram": { "bot_token": "YOUR_BOT_TOKEN", "chat_id": "YOUR_CHAT_ID" }.',
  "4. Run: bun skills/Communication/Telegram/Tools/TelegramClient.ts get-chat-id",
].join(" ");

const CHAT_ID_HINT =
  "telegram.chat_id is not set in secrets.json. Run: bun skills/Communication/Telegram/Tools/TelegramClient.ts get-chat-id";

/** A push: a message Kaya sends to Jm's chat on its own. */
function isPush(method: string): boolean {
  return method.startsWith("send");
}

function credentialsFor(method: string): TelegramCredentials {
  try {
    return {
      botToken: requireSecret("telegram.bot_token", BOTFATHER_HINT),
      chatId: optionalSecret("telegram.chat_id"),
    };
  } catch (err) {
    // SecretError messages hold the kind, key path and hint — never a value.
    if (err instanceof SecretError) throw new TelegramTransportError("config", method, err.message);
    throw err;
  }
}

/** The bot token and Jm's chat_id. Sync, no cache: every call reads secrets.json. */
export function readTelegramCredentials(): TelegramCredentials {
  return credentialsFor("readTelegramCredentials");
}

function buildBody(params: TelegramParams): { body: string | FormData; headers: Record<string, string> } {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean | Blob | object] => entry[1] !== undefined,
  );
  if (!entries.some(([, value]) => value instanceof Blob)) {
    return { body: JSON.stringify(Object.fromEntries(entries)), headers: { "Content-Type": "application/json" } };
  }
  const form = new FormData();
  for (const [key, value] of entries) {
    if (value instanceof Blob) form.append(key, value);
    else if (typeof value === "object") form.append(key, JSON.stringify(value));
    else form.append(key, String(value));
  }
  return { body: form, headers: {} };
}

interface ApiReply {
  httpStatus: number;
  ok: boolean;
  result: unknown;
  description: string;
  retryAfter: number;
}

function field(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? Reflect.get(obj, key) : undefined;
}

async function attempt(
  method: string,
  url: string,
  params: TelegramParams,
  timeoutMs: number,
  botToken: string,
): Promise<ApiReply> {
  const signal = AbortSignal.timeout(timeoutMs);
  let httpStatus: number;
  let text: string;
  try {
    const response = await globalThis.fetch(url, { method: "POST", ...buildBody(params), signal });
    httpStatus = response.status;
    text = await response.text();
  } catch (err) {
    if (signal.aborted) throw new TelegramTransportError("timeout", method, `no answer within ${timeoutMs} ms`);
    // Bun fetch errors carry the URL (with the token): scrub, never attach the original.
    const detail = redactSecrets(err instanceof Error ? err.message : err, [botToken]);
    throw new TelegramTransportError("network", method, detail);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TelegramTransportError("bad-response", method, `HTTP ${httpStatus}: body is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof field(parsed, "ok") !== "boolean") {
    throw new TelegramTransportError("bad-response", method, `HTTP ${httpStatus}: no boolean "ok" in the body`);
  }

  const description = field(parsed, "description");
  const parameters = field(parsed, "parameters");
  const retryAfter =
    typeof parameters === "object" && parameters !== null ? field(parameters, "retry_after") : undefined;
  return {
    httpStatus,
    ok: field(parsed, "ok") === true,
    result: field(parsed, "result"),
    description: redactSecrets(typeof description === "string" ? description : "(no description)", [botToken]),
    retryAfter: typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : DEFAULT_RETRY_AFTER_S,
  };
}

/**
 * Call a Bot API method. `send*` methods are pushes: gated by the push switch and
 * always sent to Jm's configured chat. Throws TelegramTransportError for config,
 * network, timeout and bad-response failures; a Telegram `ok:false` is `rejected`.
 */
export async function telegramCall<T = unknown>(
  method: string,
  params: TelegramParams = {},
  opts: { timeoutMs?: number } = {},
): Promise<TelegramOutcome<T>> {
  const push = isPush(method);
  // 1. Push switch first: nothing read, nothing sent.
  if (push && !isTelegramPushEnabled()) return { status: "suppressed" };

  // 2. Credentials.
  const { botToken, chatId } = credentialsFor(method);

  // 3. Jm's chat only.
  if (params.chat_id !== undefined) {
    throw new TelegramTransportError("config", method, "a caller chat_id is not allowed; pushes go to Jm's chat only");
  }
  let body: TelegramParams = params;
  if (push) {
    if (chatId === null) throw new TelegramTransportError("config", method, CHAT_ID_HINT);
    body = { chat_id: chatId, ...params };
  }

  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 4–7. Body per attempt, timeout per attempt, one retry on 429.
  let reply = await attempt(method, url, body, timeoutMs, botToken);
  if (!reply.ok && reply.httpStatus === 429) {
    await Bun.sleep(reply.retryAfter * 1000);
    reply = await attempt(method, url, body, timeoutMs, botToken);
  }
  if (!reply.ok) return { status: "rejected", httpStatus: reply.httpStatus, description: reply.description };

  const result = reply.result;
  const messageId =
    typeof result === "object" && result !== null && typeof field(result, "message_id") === "number"
      ? Number(field(result, "message_id"))
      : null;
  // The result shape is Telegram's contract for `method`; the caller names it with T.
  return { status: "ok", result: result as T, messageId };
}
