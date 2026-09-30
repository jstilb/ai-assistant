#!/usr/bin/env bun
/**
 * PreflightCheck.ts — Verify external tool availability before assessment
 *
 * Usage:
 *   bun PreflightCheck.ts          # Check all tools
 *   bun PreflightCheck.ts nuclei   # Check a specific tool
 *
 * Exit codes:
 *   0 — All required tools available (optional tools may be missing)
 *   1 — One or more required tools are missing
 */

import { spawnSync } from 'child_process';

interface ToolSpec {
  name: string;
  versionFlag: string;
  minVersion?: string;
  required: boolean;
  installHint: string;
}

interface ToolCheckResult {
  spec: ToolSpec;
  available: boolean;
  version?: string;
  error?: string;
}

const REQUIRED_TOOLS: ToolSpec[] = [
  {
    name: 'nuclei',
    versionFlag: '-version',
    minVersion: '3.0',
    required: false,
    installHint: 'go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest',
  },
  {
    name: 'ffuf',
    versionFlag: '-V',
    minVersion: '2.0',
    required: false,
    installHint: 'go install github.com/ffuf/ffuf/v2@latest',
  },
  {
    name: 'nmap',
    versionFlag: '--version',
    required: false,
    installHint: 'brew install nmap',
  },
  {
    name: 'subfinder',
    versionFlag: '-version',
    required: false,
    installHint: 'go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest',
  },
  {
    name: 'amass',
    versionFlag: 'version',
    required: false,
    installHint: 'brew install amass',
  },
  {
    name: 'python3',
    versionFlag: '--version',
    minVersion: '3.9',
    required: true,
    installHint: 'brew install python3',
  },
];

function checkTool(spec: ToolSpec): ToolCheckResult {
  const result = spawnSync(spec.name, [spec.versionFlag], {
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (result.error || (result.status !== 0 && result.status !== null)) {
    // Some tools (amass version) exit 0 on stdout, others print to stderr
    const combined = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    if (!combined) {
      return {
        spec,
        available: false,
        error: `Not found — install with: ${spec.installHint}`,
      };
    }
    // Still got output despite non-zero exit (e.g. nuclei -version)
    return { spec, available: true, version: combined.split('\n')[0].trim() };
  }

  const combined = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  const version = combined.split('\n')[0].trim();
  return { spec, available: true, version };
}

function printTable(results: ToolCheckResult[]): void {
  const COL = { name: 12, status: 8, version: 40, hint: 60 };

  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  const header = [
    pad('TOOL', COL.name),
    pad('STATUS', COL.status),
    pad('VERSION / INFO', COL.version),
  ].join('  ');

  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const status = r.available ? 'OK' : (r.spec.required ? 'MISSING*' : 'missing');
    const info = r.available ? (r.version ?? '') : (r.error ?? '');
    console.log([
      pad(r.spec.name, COL.name),
      pad(status, COL.status),
      pad(info, COL.version),
    ].join('  '));
  }

  console.log('');

  const missing = results.filter(r => !r.available);
  if (missing.length > 0) {
    console.log('Install commands for missing tools:');
    for (const r of missing) {
      console.log(`  ${r.spec.name}: ${r.spec.installHint}`);
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filter = args[0]?.toLowerCase();

  const tools = filter
    ? REQUIRED_TOOLS.filter(t => t.name.toLowerCase() === filter)
    : REQUIRED_TOOLS;

  if (filter && tools.length === 0) {
    console.error(`Unknown tool: ${filter}`);
    console.error(`Known tools: ${REQUIRED_TOOLS.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  console.log('WebAssessment Preflight Check');
  console.log(`Checking ${tools.length} tool(s)...`);

  const results: ToolCheckResult[] = tools.map(checkTool);

  printTable(results);

  const requiredMissing = results.filter(r => !r.available && r.spec.required);
  if (requiredMissing.length > 0) {
    console.error(`ERROR: ${requiredMissing.length} required tool(s) missing: ${requiredMissing.map(r => r.spec.name).join(', ')}`);
    process.exit(1);
  }

  const optionalMissing = results.filter(r => !r.available && !r.spec.required);
  if (optionalMissing.length > 0) {
    console.log(`Note: ${optionalMissing.length} optional tool(s) not installed. Assessment may have limited capabilities.`);
  } else {
    console.log('All tools available.');
  }

  process.exit(0);
}

main();
