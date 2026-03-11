#!/usr/bin/env bun
/**
 * NotebookLM.ts
 *
 * Kaya wrapper for the nlm CLI (notebooklm-cli)
 * Passes through to the native nlm command with Kaya-style interface
 *
 * Usage: kaya-cli notebooklm <command> [options]
 * Alias: kaya-cli nlm <command> [options]
 *
 * The underlying nlm CLI is installed via: pipx install notebooklm-cli
 * See: https://github.com/jacob-bd/notebooklm-cli
 */

import { spawn } from 'child_process';

const HELP = `
NotebookLM CLI - Command-line interface for Google NotebookLM

This is a Kaya wrapper for the nlm CLI (notebooklm-cli).
All commands are passed through to the native nlm command.

Usage:
  kaya-cli nlm <command> [options]
  kaya-cli notebooklm <command> [options]

Commands:
  login                   Authenticate with NotebookLM (opens Chrome)
  auth status             Check authentication status

  notebook list           List all notebooks
  notebook create "Title" Create a new notebook
  notebook get <id>       Get notebook details
  notebook query <id> "?" Query a notebook
  notebook delete <id>    Delete a notebook (requires --confirm)

  source list <nb-id>     List sources in a notebook
  source add <nb-id>      Add a source (--url, --text, --drive)
  source content <src-id> Extract source text

  chat start <nb-id>      Start interactive chat session

  audio create <nb-id>    Generate podcast (requires --confirm)
  report create <nb-id>   Create study guide/report
  quiz create <nb-id>     Generate quiz questions
  flashcards create <nb-id> Create flashcards
  mindmap create <nb-id>  Generate mind map
  slides create <nb-id>   Create presentation
  video create <nb-id>    Create video overview

  research start "query"  Start web/drive research
  research status <nb-id> Check research progress
  research import <nb-id> Import research results

  alias set <name> <id>   Create shortcut for notebook ID
  alias list              List all aliases
  alias get <name>        Resolve alias to ID

  config show             Show configuration
  studio status <nb-id>   List generated artifacts

Output Formats:
  --json                  JSON output
  --quiet                 IDs only
  --full                  All columns
  --title                 "ID: Title" format

Examples:
  kaya-cli nlm login                          # Authenticate
  kaya-cli nlm notebook list                  # List notebooks
  kaya-cli nlm notebook query abc123 "What is the main topic?"
  kaya-cli nlm source add abc123 --url "https://example.com/article"
  kaya-cli nlm audio create abc123 --confirm  # Generate podcast
  kaya-cli nlm alias set myproject abc123     # Create shortcut
  kaya-cli nlm notebook query myproject "Summarize"

Authentication:
  Run 'kaya-cli nlm login' to authenticate via Chrome.
  Sessions last ~20 minutes before requiring re-auth.

Installation:
  The nlm CLI is installed via: pipx install notebooklm-cli
  Requires: Python 3.10+, Google Chrome

Documentation:
  https://github.com/jacob-bd/notebooklm-cli
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Show Kaya help if no args or --help
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  // Check if nlm is installed
  const which = Bun.spawnSync(['which', 'nlm']);
  if (which.exitCode !== 0) {
    console.error('Error: nlm CLI not found');
    console.error('');
    console.error('Install it with: pipx install notebooklm-cli');
    console.error('Requires: Python 3.10+, Google Chrome');
    process.exit(1);
  }

  // Pass through to nlm
  const nlm = spawn('nlm', args, {
    stdio: 'inherit',
    env: process.env,
  });

  nlm.on('close', (code) => {
    process.exit(code ?? 0);
  });

  nlm.on('error', (err) => {
    console.error('Error running nlm:', err.message);
    process.exit(1);
  });
}

main();
