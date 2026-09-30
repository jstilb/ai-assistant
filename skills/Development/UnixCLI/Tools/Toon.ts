#!/usr/bin/env bun
/**
 * Toon.ts
 *
 * JSON <-> TOON format converter CLI
 * TOON (Token-Oriented Object Notation) achieves ~40-60% fewer tokens than JSON
 * while maintaining lossless round-trip conversion. Ideal for LLM contexts.
 *
 * Usage: kaya-cli toon <command> [options]
 * Docs: https://github.com/toon-format/toon
 */

import { parseArgs } from 'util';
import { encode, decode } from '@toon-format/toon';

const HELP = `
TOON CLI - Convert between JSON and TOON (Token-Oriented Object Notation)

Usage:
  kaya-cli toon <command> [file] [options]

Commands:
  encode              Convert JSON to TOON (stdin or file)
  decode              Convert TOON to JSON (stdin or file)
  stats               Show token savings estimate for a JSON file/input

Arguments:
  file                Path to input file (reads stdin if omitted)

Options:
  --pretty, -p        Pretty-print decoded JSON (default: compact)
  --json, -j          Output stats as JSON
  --help, -h          Show this help

Examples:
  kaya-cli toon encode data.json              # File to stdout
  cat data.json | kaya-cli toon encode        # Pipe JSON in, TOON out
  kaya-cli toon decode data.toon              # TOON file to JSON
  cat data.toon | kaya-cli toon decode -p     # Pretty JSON output
  kaya-cli toon stats data.json               # Show token savings
  echo '{"a":1}' | kaya-cli toon encode      # Inline conversion

Piping:
  kaya-cli tasks --json | kaya-cli toon encode            # Pipe from other CLIs
  kaya-cli toon decode data.toon | jq '.items[0]'      # Pipe to jq

Docs: https://github.com/toon-format/toon
`;

interface ToonOptions {
  pretty: boolean;
  json: boolean;
  help: boolean;
}

async function readInput(filePath?: string): Promise<string> {
  if (filePath) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`);
    }
    return file.text();
  }

  // Read from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) {
    throw new Error('No input received. Provide a file path or pipe data via stdin.');
  }
  return text;
}

function estimateTokens(text: string): number {
  // Rough GPT-style tokenizer estimate: ~4 chars per token for English/structured text
  return Math.ceil(text.length / 4);
}

async function encodeCmd(filePath: string | undefined, _opts: ToonOptions): Promise<void> {
  const input = await readInput(filePath);
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON input. Ensure the input is valid JSON.');
  }
  const toonStr = encode(data);
  process.stdout.write(toonStr + '\n');
}

async function decodeCmd(filePath: string | undefined, opts: ToonOptions): Promise<void> {
  const input = await readInput(filePath);
  let data: unknown;
  try {
    data = decode(input);
  } catch {
    throw new Error('Invalid TOON input. Ensure the input is valid TOON format.');
  }
  const indent = opts.pretty ? 2 : undefined;
  process.stdout.write(JSON.stringify(data, null, indent) + '\n');
}

async function statsCmd(filePath: string | undefined, opts: ToonOptions): Promise<void> {
  const input = await readInput(filePath);
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error('Invalid JSON input. Provide valid JSON to estimate savings.');
  }

  const jsonStr = JSON.stringify(data);
  const jsonPretty = JSON.stringify(data, null, 2);
  const toonStr = encode(data);

  const jsonTokens = estimateTokens(jsonStr);
  const jsonPrettyTokens = estimateTokens(jsonPretty);
  const toonTokens = estimateTokens(toonStr);

  const savingsCompact = ((1 - toonTokens / jsonTokens) * 100).toFixed(1);
  const savingsPretty = ((1 - toonTokens / jsonPrettyTokens) * 100).toFixed(1);

  if (opts.json) {
    const stats = {
      json_compact: { chars: jsonStr.length, estimated_tokens: jsonTokens },
      json_pretty: { chars: jsonPretty.length, estimated_tokens: jsonPrettyTokens },
      toon: { chars: toonStr.length, estimated_tokens: toonTokens },
      savings: {
        vs_compact: `${savingsCompact}%`,
        vs_pretty: `${savingsPretty}%`,
      },
    };
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`Format          Chars    ~Tokens`);
    console.log(`──────────────  ───────  ───────`);
    console.log(`JSON (compact)  ${String(jsonStr.length).padStart(7)}  ${String(jsonTokens).padStart(7)}`);
    console.log(`JSON (pretty)   ${String(jsonPretty.length).padStart(7)}  ${String(jsonPrettyTokens).padStart(7)}`);
    console.log(`TOON            ${String(toonStr.length).padStart(7)}  ${String(toonTokens).padStart(7)}`);
    console.log(``);
    console.log(`Savings vs compact JSON:  ${savingsCompact}%`);
    console.log(`Savings vs pretty JSON:   ${savingsPretty}%`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pretty: { type: 'boolean', short: 'p', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const opts: ToonOptions = {
    pretty: values.pretty as boolean,
    json: values.json as boolean,
    help: values.help as boolean,
  };

  if (opts.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const command = positionals[0];
  const filePath = positionals[1];

  switch (command) {
    case 'encode':
    case 'e':
      await encodeCmd(filePath, opts);
      break;
    case 'decode':
    case 'd':
      await decodeCmd(filePath, opts);
      break;
    case 'stats':
    case 's':
      await statsCmd(filePath, opts);
      break;
    default:
      console.error(`Error: Unknown command '${command}'`);
      console.error(`Run 'kaya-cli toon --help' for usage`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
