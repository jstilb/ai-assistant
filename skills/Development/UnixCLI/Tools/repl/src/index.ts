#!/usr/bin/env bun
/**
 * Kaya CLI Interactive REPL
 *
 * Provides an interactive shell for kaya-cli commands with history,
 * tab completion, and context persistence.
 */

import * as readline from 'readline';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const HISTORY_FILE = join(process.env.HOME!, '.claude', '.kaya-cli-history');
const MAX_HISTORY = 1000;

const SERVICES = [
  'youtube', 'yt',
  'calendar', 'gcal',
  'drive',
  'gmail',
  'gemini', 'ai',
  'sheets',
  'places',
  'tasks', 'lt',
  'playwright', 'pw', 'browser',
  'bluesky', 'bsky',
  'weather',
  'linear',
  'slack',
  'github', 'gh',
  'gitlab',
  'op', 'secrets',
  'stripe',
  'supabase',
  'firebase',
];

const TASKS_SUBCOMMANDS = ['list', 'add', 'complete', 'delete', 'update', 'search', 'stats', 'inbox'];
const GITHUB_SUBCOMMANDS = ['pr', 'issue', 'repo', 'workflow', 'release'];
const GITLAB_SUBCOMMANDS = ['mr', 'issue', 'project', 'pipeline'];

const BANNER = `
\x1b[36m╔══════════════════════════════════════════════════════════════╗
║                    Kaya CLI Interactive REPL                    ║
║                                                                ║
║  Type a service name followed by options, or use shortcuts:    ║
║    tasks list --json                                           ║
║    weather "San Francisco"                                     ║
║    github pr list                                              ║
║                                                                ║
║  Commands:                                                     ║
║    help, ?     Show this help                                  ║
║    services    List available services                         ║
║    history     Show command history                            ║
║    clear       Clear screen                                    ║
║    exit, quit  Exit REPL                                       ║
╚══════════════════════════════════════════════════════════════╝
\x1b[0m`;

class KayaCliRepl {
  private rl: readline.Interface;
  private history: string[] = [];
  private context: Map<string, any> = new Map();

  constructor() {
    this.loadHistory();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[32mkaya>\x1b[0m ',
      historySize: MAX_HISTORY,
      completer: this.completer.bind(this),
    });

    // Load history into readline
    for (const cmd of this.history) {
      (this.rl as any).history.push(cmd);
    }
  }

  private loadHistory(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const content = readFileSync(HISTORY_FILE, 'utf-8');
        this.history = content.split('\n').filter(Boolean);
      }
    } catch (e) {
      // Ignore history load errors
    }
  }

  private saveHistory(): void {
    try {
      const dir = join(process.env.HOME!, '.claude');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(HISTORY_FILE, this.history.slice(-MAX_HISTORY).join('\n'));
    } catch (e) {
      // Ignore history save errors
    }
  }

  private addToHistory(cmd: string): void {
    if (cmd && cmd !== this.history[this.history.length - 1]) {
      this.history.push(cmd);
      this.saveHistory();
    }
  }

  private completer(line: string): [string[], string] {
    const parts = line.split(/\s+/);
    const current = parts[parts.length - 1];

    if (parts.length === 1) {
      // Complete service names
      const matches = SERVICES.filter(s => s.startsWith(current));
      return [matches.length ? matches : SERVICES, current];
    }

    const service = parts[0];
    if (parts.length === 2) {
      // Complete subcommands
      let subcommands: string[] = [];
      if (service === 'tasks' || service === 'lt') {
        subcommands = TASKS_SUBCOMMANDS;
      } else if (service === 'github' || service === 'gh') {
        subcommands = GITHUB_SUBCOMMANDS;
      } else if (service === 'gitlab') {
        subcommands = GITLAB_SUBCOMMANDS;
      }

      const matches = subcommands.filter(s => s.startsWith(current));
      return [matches.length ? matches : subcommands, current];
    }

    return [[], current];
  }

  private async executeCommand(cmd: string): Promise<void> {
    return new Promise((resolve) => {
      const args = ['kaya-cli', ...this.parseCommand(cmd)];
      const kayaCli = join(process.env.HOME!, '.claude', 'bin', 'kaya-cli');

      const proc = spawn(kayaCli, this.parseCommand(cmd), {
        stdio: 'inherit',
        env: process.env,
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.log(`\x1b[33mCommand exited with code ${code}\x1b[0m`);
        }
        resolve();
      });

      proc.on('error', (err) => {
        console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
        resolve();
      });
    });
  }

  private parseCommand(cmd: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const char of cmd) {
      if ((char === '"' || char === "'") && !inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuote) {
        inQuote = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuote) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      args.push(current);
    }

    return args;
  }

  private handleBuiltinCommand(cmd: string): boolean {
    const trimmed = cmd.trim().toLowerCase();

    switch (trimmed) {
      case 'help':
      case '?':
        console.log(BANNER);
        return true;

      case 'services':
        console.log('\n\x1b[36mAvailable services:\x1b[0m');
        const grouped = {
          'Media': ['youtube/yt'],
          'Google': ['calendar/gcal', 'drive', 'gmail', 'gemini/ai', 'sheets', 'places'],
          'Task Management': ['tasks/lt', 'linear'],
          'Code': ['github/gh', 'gitlab'],
          'Communication': ['slack', 'bluesky/bsky'],
          'Cloud': ['stripe', 'supabase', 'firebase'],
          'Security': ['op/secrets'],
          'Other': ['weather', 'playwright/pw/browser'],
        };
        for (const [category, services] of Object.entries(grouped)) {
          console.log(`  \x1b[33m${category}:\x1b[0m ${services.join(', ')}`);
        }
        console.log('');
        return true;

      case 'history':
        console.log('\n\x1b[36mRecent commands:\x1b[0m');
        this.history.slice(-20).forEach((cmd, i) => {
          console.log(`  ${i + 1}. ${cmd}`);
        });
        console.log('');
        return true;

      case 'clear':
        console.clear();
        return true;

      case 'exit':
      case 'quit':
      case '.exit':
        console.log('\x1b[36mGoodbye!\x1b[0m');
        this.rl.close();
        process.exit(0);

      default:
        return false;
    }
  }

  async start(): Promise<void> {
    console.log(BANNER);

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const cmd = line.trim();

      if (!cmd) {
        this.rl.prompt();
        return;
      }

      // Check for built-in commands first
      if (this.handleBuiltinCommand(cmd)) {
        this.rl.prompt();
        return;
      }

      // Execute kaya-cli command
      this.addToHistory(cmd);
      await this.executeCommand(cmd);
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log('\n\x1b[36mGoodbye!\x1b[0m');
      process.exit(0);
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      console.log('\n\x1b[33mUse "exit" or Ctrl+D to quit\x1b[0m');
      this.rl.prompt();
    });
  }
}

// Main
const repl = new KayaCliRepl();
repl.start();
