#!/usr/bin/env bun
/**
 * Terminal Backend — Executes commands from Canvas terminal containers
 *
 * Connects to the Kaya daemon as a WebSocket client and listens for
 * canvas.container.event notifications with event='input' from terminal
 * containers. Executes the command via Bun.spawn and streams output back.
 *
 * Usage:
 *   bun ~/.claude/skills/Canvas/Tools/TerminalBackend.ts
 *   bun ~/.claude/skills/Canvas/Tools/TerminalBackend.ts --cwd /some/path
 */

import { CanvasClient } from './CanvasClient.ts';

const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const cwd = cwdIndex !== -1 && args[cwdIndex + 1]
  ? args[cwdIndex + 1]
  : process.env.HOME ?? '/tmp';

const client = new CanvasClient();

try {
  await client.connect();
} catch (err) {
  console.error('Failed to connect to daemon:', err);
  process.exit(1);
}

console.log(`Terminal backend connected (cwd: ${cwd})`);

client.onContainerEvent(async (event) => {
  if (event.event !== 'input') return;

  const data = event.data as { value?: string } | undefined;
  const command = data?.value?.trim();
  if (!command) return;

  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    // Build output: stdout first, then stderr in red
    let output = stdout;
    if (stderr) {
      output += (output && !output.endsWith('\n') ? '\n' : '')
        + stderr.split('\n').map((l) => l ? `\x1b[31m${l}\x1b[0m` : '').join('\n');
    }

    // Remove trailing newline to avoid extra blank line
    output = output.replace(/\n$/, '');

    if (output) {
      await client.streamToContainer(event.id, output);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.streamToContainer(event.id, `\x1b[31mError: ${msg}\x1b[0m`);
  }
});

// Keep process alive
process.on('SIGINT', () => {
  console.log('Terminal backend shutting down');
  client.destroy();
  process.exit(0);
});
