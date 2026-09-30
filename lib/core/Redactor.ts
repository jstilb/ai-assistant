/**
* Redactor — mask tokens/credentials before they hit logs.
 *
 * Root cause this exists for (security-audit S-08 addendum, 2026-09-08):
 * Telegraf's own redactToken() throws on Bun (Error.message is readonly), so
 * the raw Telegram bot token reaches console.error via the swallowed-error
 * path in TelegramBot.ts (a Bun fetch-error object dump with a `.path` like
 * `https://api.telegram.org/bot<token>/getMe`). Separately, SyncRunner.ts
 * shells out to `git` with stdio:"inherit" for clone/pull/push against a
 * token-bearing HTTPS remote — a failing git process prints
 * `fatal: unable to access 'https://<token>@…'` straight to the inherited
 * (previously unredacted) stderr.
 *
 * Pure, dependency-free: formats an arbitrary value (string, Error, plain
 * object — via util.inspect, which already appends an Error's own
 * enumerable extra properties like a fetch error's `.path`) and strips known
 * secret SHAPES plus any registered or explicitly-passed literal secrets.
 *
 * Usage:
 *   import {
 *     redactSecrets,
 *     registerKnownSecret,
 *     installRedactingConsole,
 *   } from "lib/core/Redactor.ts";
 *
 *   redactSecrets(err);                          // pattern-based masking only
 *   redactSecrets(stderr, [token]);               // + one-off literal mask
 *   registerKnownSecret(token);                   // mask this value everywhere, from now on
 *   const uninstall = installRedactingConsole();  // console.error/warn now redact every arg
 */

import * as util from "node:util";

const TELEGRAM_BOT_TOKEN_RE = /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g;
const URL_USERINFO_RE = /(https?:\/\/)[^\s/@]+@/g;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;

const registeredSecrets = new Set<string>();

/**
 * Register a literal secret value to be masked by every future
 * redactSecrets() call regardless of call site — for values (like a loaded
 * bot token) that may not match any of the known SHAPE patterns above.
 */
export function registerKnownSecret(secret: string): void {
  if (secret.length > 0) registeredSecrets.add(secret);
}

/** Test-only: clear registered secrets so state doesn't leak across tests. */
export function clearKnownSecrets(): void {
  registeredSecrets.clear();
}

function formatValue(input: unknown): string {
  if (typeof input === "string") return input;
  // depth:null + no truncation so a secret nested a few levels deep (or a
  // long token) isn't hidden behind "..." — hidden-by-truncation is not the
  // same guarantee as redacted, and we want the latter to actually run.
  return util.inspect(input, {
    depth: null,
    breakLength: Infinity,
    maxStringLength: Infinity,
    maxArrayLength: Infinity,
  });
}

function maskLiteral(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join("<redacted>");
}

/**
 * Format `input` and replace known secret shapes (Telegram bot tokens, URL
 * userinfo, GitHub token/PAT shapes) plus any registered (registerKnownSecret)
 * or explicitly-passed (`knownSecrets`) literal secrets. Always returns a
 * string safe to log.
 */
export function redactSecrets(input: unknown, knownSecrets: readonly string[] = []): string {
  let text = formatValue(input);

  for (const secret of registeredSecrets) {
    text = maskLiteral(text, secret);
  }
  for (const secret of knownSecrets) {
    text = maskLiteral(text, secret);
  }

  text = text.replace(TELEGRAM_BOT_TOKEN_RE, "bot<redacted>");
  text = text.replace(URL_USERINFO_RE, "$1***@");
  text = text.replace(GITHUB_TOKEN_RE, "<redacted>");
  text = text.replace(GITHUB_PAT_RE, "<redacted>");

  return text;
}

type ConsoleStream = "error" | "warn";
type ConsoleMethod = typeof console.error;

const consoleState: Record<ConsoleStream, { original: ConsoleMethod | null; depth: number }> = {
  error: { original: null, depth: 0 },
  warn: { original: null, depth: 0 },
};

/**
 * Wrap console.error/console.warn (or a subset) so every argument passed to
 * them goes through redactSecrets() before the real console method sees it.
 * Idempotent: nested install/uninstall pairs ref-count per stream instead of
 * double-wrapping (which would just double-redact, harmlessly, but is
 * unnecessary work) or restoring the real console early out from under a
 * still-active caller. Returns an uninstall function.
 */
export function installRedactingConsole(
  streams: readonly ConsoleStream[] = ["error", "warn"],
): () => void {
  const touched: ConsoleStream[] = [];

  for (const stream of streams) {
    const state = consoleState[stream];
    if (state.depth === 0) {
      // Store the raw reference (not .bind(console)) so uninstall() can hand
      // back the exact original function — Node/Bun's console methods don't
      // need external `this`-binding to work when invoked directly.
      const original = console[stream];
      state.original = original;
      console[stream] = ((...args: unknown[]) => {
        original(...args.map((arg) => redactSecrets(arg)));
      }) as ConsoleMethod;
    }
    state.depth++;
    touched.push(stream);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const stream of touched) {
      const state = consoleState[stream];
      state.depth = Math.max(0, state.depth - 1);
      if (state.depth === 0 && state.original) {
        console[stream] = state.original;
        state.original = null;
      }
    }
  };
}
