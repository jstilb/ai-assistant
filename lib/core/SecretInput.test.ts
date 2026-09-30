import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readSecretInput, SecretInputError } from "./SecretInput.ts";

const synthetic = "synthetic-private-input";

class Terminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  failEnable = false;
  failRestore = false;
  setRawMode(mode: boolean): this {
    if ((mode && this.failEnable) || (!mode && this.failRestore)) throw new Error(synthetic);
    this.isRaw = mode;
    return this;
  }
}

function fixture(raw = false, flowing = false) {
  const input = new Terminal();
  input.isRaw = raw;
  if (flowing) input.resume(); else input.pause();
  let output = "";
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const promise = readSecretInput("Credential: ", { input, write: (text) => { output += text; } });
  const clean = () => {
    expect(input.isRaw).toBe(raw);
    expect(input.readableFlowing).toBe(flowing);
    for (const event of ["data", "end", "close", "error"]) expect(input.listenerCount(event)).toBe(0);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
    expect(output).not.toContain(synthetic);
    expect(output).toBe("Credential: \n");
  };
  return { input, promise, clean };
}

describe("credential input", () => {
  test("pipe trims a nonempty value without prompting", async () => {
    const input = new Terminal(); input.isTTY = false;
    const value = await readSecretInput("unused", {
      input, readPipe: async () => `  ${synthetic}\n`, write: () => { throw new Error("prompted"); },
    });
    expect(value).toBe(synthetic);
    expect(input.isRaw).toBe(false);
  });

  for (const kind of ["empty", "read"] as const) {
    test(`pipe ${kind} becomes a sanitized typed error`, async () => {
      const input = new Terminal(); input.isTTY = false;
      const promise = readSecretInput("unused", {
        input, readPipe: async () => { if (kind === "read") throw new Error(synthetic); return " \n"; },
      });
      await expect(promise).rejects.toMatchObject({ name: "SecretInputError", code: kind, exitCode: 1 });
      await expect(promise).rejects.not.toThrow(synthetic);
    });
  }

  test("TTY hides input, edits characters, stops at first submitted line, restores state", async () => {
    const f = fixture();
    expect(f.input.isRaw).toBe(true);
    f.input.emit("data", Buffer.from(` ${synthetic}X\x7f \rdiscarded`));
    expect(await f.promise).toBe(synthetic);
    f.clean();
  });

  test("TTY preserves raw and flowing state and decodes split UTF-8", async () => {
    const f = fixture(true, true);
    const bytes = Buffer.from("é");
    f.input.emit("data", bytes.subarray(0, 1));
    f.input.emit("data", bytes.subarray(1));
    f.input.emit("data", "\bvalue\n");
    expect(await f.promise).toBe("value");
    f.clean();
  });

  for (const [event, chunk, code] of [
    ["data", "\x03", "cancelled"], ["data", "\x04", "eof"],
    ["end", "", "eof"], ["close", "", "eof"], ["error", "", "read"],
    ["data", "\n", "empty"],
  ] as const) {
    test(`TTY ${event}/${code} removes listeners and restores terminal`, async () => {
      const f = fixture();
      if (code !== "empty") f.input.emit("data", synthetic);
      f.input.emit(event, event === "error" ? new Error(synthetic) : chunk);
      await expect(f.promise).rejects.toMatchObject({ code });
      await expect(f.promise).rejects.not.toThrow(synthetic);
      f.clean();
    });
  }

  for (const [signal, code, exitCode] of [["SIGINT", "cancelled", 130], ["SIGTERM", "terminated", 143]] as const) {
    test(`TTY ${signal} restores before rejecting`, async () => {
      const f = fixture();
      f.input.emit("data", synthetic);
      process.emit(signal, signal);
      await expect(f.promise).rejects.toMatchObject({ code, exitCode });
      f.clean();
    });
  }

  test("TTY setup failure is sanitized and does not leave listeners", async () => {
    const input = new Terminal(); input.pause(); input.failEnable = true;
    const events = input.eventNames();
    await expect(readSecretInput("unused", { input, write: () => {} })).rejects.toMatchObject({ code: "read" });
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.eventNames()).toEqual(events);
  });

  test("TTY failed restoration is visible and does not return a credential", async () => {
    const f = fixture();
    f.input.failRestore = true;
    f.input.emit("data", `${synthetic}\n`);
    await expect(f.promise).rejects.toMatchObject({ code: "restore" });
    await expect(f.promise).rejects.not.toThrow(synthetic);
    expect(f.input.listenerCount("data")).toBe(0);
    f.input.failRestore = false; f.input.setRawMode(false);
    f.clean();
  });

  test("already closed TTY rejects before prompting", async () => {
    const input = new Terminal(); input.destroy();
    await expect(readSecretInput("unused", { input, write: () => { throw new Error("prompted"); } }))
      .rejects.toBeInstanceOf(SecretInputError);
    expect(input.isRaw).toBe(false);
  });

  for (const value of [synthetic, "", " \n"]) {
    test(`real pipe subprocess ${value.trim() ? "nonempty" : "empty"} prints no credential`, () => {
      const script = `
        import { readSecretInput, SecretInputError } from ${JSON.stringify(import.meta.dir + "/SecretInput.ts")};
        try { const value = await readSecretInput('unused'); console.log(value.length); }
        catch (error) { if (!(error instanceof SecretInputError)) throw error; console.error(error.code); process.exit(error.exitCode); }
      `;
      const result = Bun.spawnSync([process.execPath, "-e", script], { stdin: Buffer.from(value), stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(value.trim() ? 0 : 1);
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain(synthetic);
      expect(result.stdout.toString()).toBe(value.trim() ? `${synthetic.length}\n` : "");
      expect(result.stderr.toString()).toBe(value.trim() ? "" : "empty\n");
    });
  }
});
