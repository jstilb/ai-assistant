import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

type InputFailure = "empty" | "cancelled" | "terminated" | "eof" | "read" | "restore";

const messages: Record<InputFailure, string> = {
  empty: "No credential entered — nothing was written.",
  cancelled: "Credential input cancelled — nothing was written.",
  terminated: "Credential input terminated — nothing was written.",
  eof: "Credential input ended before submission — nothing was written.",
  read: "Could not read credential input — nothing was written.",
  restore: "Could not restore terminal state — nothing was written. Check the terminal privately.",
};

export class SecretInputError extends Error {
  get exitCode(): number { return this.code === "cancelled" ? 130 : this.code === "terminated" ? 143 : 1; }
  constructor(readonly code: InputFailure) {
    super(messages[code]);
    this.name = "SecretInputError";
  }
}

interface SecretInputIO {
  input: Pick<Readable, "readableFlowing" | "readableEnded" | "destroyed" | "pause" | "resume" | "on" | "off"> & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode(mode: boolean): void;
  };
  write(text: string): void;
  readPipe(): Promise<string>;
}

export async function readSecretInput(prompt: string, overrides: Partial<SecretInputIO> = {}): Promise<string> {
  const io: SecretInputIO = {
    input: process.stdin,
    write: (text) => { process.stderr.write(text); },
    readPipe: () => Bun.stdin.text(),
    ...overrides,
  };
  if (!io.input.isTTY) {
    let value: string;
    try { value = (await io.readPipe()).trim(); }
    catch { throw new SecretInputError("read"); }
    if (!value) throw new SecretInputError("empty");
    return value;
  }

  const input = io.input;
  if (input.readableEnded || input.destroyed) throw new SecretInputError("eof");
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder("utf8");

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (failure?: InputFailure) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      process.off("SIGINT", onCancel);
      process.off("SIGTERM", onTerminate);
      const value = buffer.trim();
      buffer = "";
      let result = failure ?? (value ? undefined : "empty");
      try { input.setRawMode(wasRaw); } catch { result = "restore"; }
      try { if (wasFlowing) input.resume(); else input.pause(); } catch { result = "restore"; }
      try { io.write("\n"); } catch { result ??= "read"; }
      if (result) reject(new SecretInputError(result));
      else resolve(value);
    };
    const onEnd = () => finish("eof");
    const onError = () => finish("read");
    const onCancel = () => finish("cancelled");
    const onTerminate = () => finish("terminated");
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\x03") { onCancel(); return; }
        if (character === "\x04") { onEnd(); return; }
        if (character === "\x7f" || character === "\b") {
          buffer = Array.from(buffer).slice(0, -1).join("");
        } else {
          buffer += character;
        }
      }
    };
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.on("error", onError);
      process.on("SIGINT", onCancel);
      process.on("SIGTERM", onTerminate);
      io.write(prompt);
      input.resume();
    } catch { finish("read"); }
  });
}
