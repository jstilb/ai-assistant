/**
 * FakeTelegram.ts — the test adapter at the Telegram transport's `fetch` port (ADR-036).
 *
 *   const fake = new FakeTelegram("123:fake-token");
 *   const restore = fake.install();   // swaps globalThis.fetch; call restore() in afterEach
 *   fake.failNext("sendMessage", { httpStatus: 429, description: "Too Many Requests", retryAfter: 0 });
 *   ... code under test ...
 *   expect(fake.calls[0]?.params.text).toBe("hi");
 *
 * It decodes each request the way the Bot API would (JSON or multipart), records it,
 * and answers like Telegram. It throws loudly on a non-Telegram URL or a wrong token,
 * so a test can never reach the network by accident.
 */

export interface FakeTelegramCall {
  method: string;
  /** Decoded params. A file part is recorded here as its file name. */
  params: Record<string, unknown>;
  /** Field name → file name, for each multipart file part. */
  files: Record<string, string>;
}

export type FakeTelegramFailure =
  | { httpStatus: number; description: string; retryAfter?: number }
  | "network"
  | "timeout"
  /** An HTML 502 page (a proxy answer), not Bot API JSON. */
  | "bad-response";

type FetchInput = Parameters<typeof fetch>[0];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class FakeTelegram {
  readonly calls: FakeTelegramCall[] = [];
  private readonly failures = new Map<string, FakeTelegramFailure[]>();
  private nextMessageId = 1;

  constructor(readonly token: string) {}

  /** Make the next call of `method` fail this way (queued, one use each). */
  failNext(method: string, failure: FakeTelegramFailure): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(failure);
    this.failures.set(method, queue);
  }

  /** Swap globalThis.fetch for this fake. Returns the restore function. */
  install(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign((input: FetchInput, init?: RequestInit) => this.handle(input, init), {
      preconnect: original.preconnect,
    });
    return () => {
      globalThis.fetch = original;
    };
  }

  private async handle(input: FetchInput, init?: RequestInit): Promise<Response> {
    const url = new URL(requestUrl(input));
    if (url.protocol !== "https:" || url.host !== "api.telegram.org") {
      throw new Error(`FakeTelegram: non-Telegram URL ${url.origin}${url.pathname} — stub that fetch yourself`);
    }
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!match) throw new Error("FakeTelegram: the path is not /bot<token>/<method>");
    if (match[1] !== this.token) throw new Error("FakeTelegram: the request used a wrong bot token");
    const method = match[2] ?? "";

    const call = await this.decode(method, url.href, init);
    this.calls.push(call);

    const failure = this.failures.get(method)?.shift();
    if (failure === "network") {
      // Like Bun: the message carries the full URL, token included.
      throw new TypeError(`FakeTelegram network failure: unable to connect, path: ${url.href}`);
    }
    if (failure === "timeout") return this.hang(init?.signal ?? null);
    if (failure === "bad-response") {
      return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    }
    if (failure) {
      const parameters = failure.retryAfter === undefined ? undefined : { retry_after: failure.retryAfter };
      return json(
        { ok: false, error_code: failure.httpStatus, description: failure.description, parameters },
        failure.httpStatus,
      );
    }
    return json({ ok: true, result: this.result(method, call) }, 200);
  }

  private async decode(method: string, href: string, init?: RequestInit): Promise<FakeTelegramCall> {
    const request = new Request(href, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body });
    const params: Record<string, unknown> = {};
    const files: Record<string, string> = {};
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          params[key] = value;
        } else {
          files[key] = value.name;
          params[key] = value.name;
        }
      }
    } else if (type.startsWith("application/json")) {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null) throw new Error("FakeTelegram: JSON body is not an object");
      Object.assign(params, body);
    } else if (init?.body !== undefined && init.body !== null) {
      throw new Error(`FakeTelegram: unexpected content-type "${type}"`);
    }
    return { method, params, files };
  }

  private result(method: string, call: FakeTelegramCall): unknown {
    if (method === "getUpdates") return [];
    if (method.startsWith("send")) {
      return { message_id: this.nextMessageId++, chat: { id: call.params.chat_id }, date: 0 };
    }
    return true;
  }

  private hang(signal: AbortSignal | null): Promise<Response> {
    if (!signal) throw new Error("FakeTelegram: a 'timeout' failure needs the request to carry an AbortSignal");
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}
