#!/usr/bin/env bun

/**
 * Domain Recon Aggregator
 *
 * Aggregates subdomain enumeration from multiple sources:
 * - Subfinder (passive sources)
 * - Chaos (ProjectDiscovery database)
 * - Certificate Transparency (crt.sh) - Uses CORE CachedHTTPClient
 * - DNS enumeration (dnsx)
 *
 * Usage:
 *   bun run DomainRecon.ts example.com
 *   bun run DomainRecon.ts example.com --json
 *   bun run DomainRecon.ts example.com --resolve
 */

import { $ } from "bun";
import { createHTTPClient, type CachedHTTPClient } from "../../CORE/Tools/CachedHTTPClient.ts";
import { memoryStore } from "../../CORE/Tools/MemoryStore.ts";

// Share the same crt.sh cache with DnsUtils (30-day TTL)
const certHttpClient: CachedHTTPClient = createHTTPClient({
  cacheDir: `${process.env.HOME}/.claude/.cache/crt-sh`,
  defaultTtl: 30 * 24 * 60 * 60, // 30 days
});

interface ReconResult {
  domain: string;
  subdomains: string[];
  sources: Record<string, string[]>;
  resolved?: Record<string, string[]>;
  stats: {
    total: number;
    unique: number;
    bySource: Record<string, number>;
    duration: number;
  };
}

async function runSubfinder(domain: string): Promise<string[]> {
  try {
    const result = await $`subfinder -d ${domain} -silent -all`.text();
    return result.trim().split("\n").filter(Boolean);
  } catch {
    console.error("[subfinder] Failed");
    return [];
  }
}

async function runChaos(domain: string): Promise<string[]> {
  const key = process.env.PDCP_API_KEY;
  if (!key) {
    console.error("[chaos] No PDCP_API_KEY set");
    return [];
  }
  try {
    const result = await $`chaos -key ${key} -d ${domain} -silent`.text();
    return result.trim().split("\n").filter(Boolean);
  } catch {
    console.error("[chaos] Failed");
    return [];
  }
}

async function runCrtsh(domain: string): Promise<string[]> {
  try {
    const url = `https://crt.sh/?q=%.${domain}&output=json`;

    // Use CachedHTTPClient with 30-day disk cache
    const data = await certHttpClient.fetchJson<Array<{ name_value: string }>>(url, {
      cache: 'disk',
      ttl: 30 * 24 * 60 * 60, // 30 days
      retry: 2,
      timeout: 30000, // crt.sh can be slow
    });

    const names = new Set<string>();
    for (const cert of data) {
      for (const name of cert.name_value.split("\n")) {
        if (name.endsWith(domain) && !name.startsWith("*")) {
          names.add(name.toLowerCase());
        }
      }
    }
    return Array.from(names);
  } catch {
    console.error("[crt.sh] Failed");
    return [];
  }
}

async function resolveSubdomains(
  subdomains: string[]
): Promise<Record<string, string[]>> {
  const resolved: Record<string, string[]> = {};
  try {
    const input = subdomains.join("\n");
    const result = await $`echo ${input} | dnsx -silent -a -resp`.text();
    for (const line of result.trim().split("\n")) {
      const match = line.match(/^(\S+)\s+\[(.+)\]$/);
      if (match) {
        resolved[match[1]] = match[2].split(",").map((s) => s.trim());
      }
    }
  } catch {
    console.error("[dnsx] Resolution failed");
  }
  return resolved;
}

async function main() {
  const args = process.argv.slice(2);
  const domain = args.find((a) => !a.startsWith("-"));
  const jsonOutput = args.includes("--json");
  const resolve = args.includes("--resolve");

  if (!domain) {
    console.log("Usage: DomainRecon.ts <domain> [--json] [--resolve]");
    process.exit(1);
  }

  const startTime = Date.now();
  console.error(`[*] Starting recon for ${domain}`);

  // Run sources in parallel
  const [subfinderResults, chaosResults, crtshResults] = await Promise.all([
    runSubfinder(domain),
    runChaos(domain),
    runCrtsh(domain),
  ]);

  // Deduplicate
  const allSubdomains = new Set<string>();
  const sources: Record<string, string[]> = {
    subfinder: subfinderResults,
    chaos: chaosResults,
    crtsh: crtshResults,
  };

  for (const results of Object.values(sources)) {
    for (const sub of results) {
      allSubdomains.add(sub.toLowerCase());
    }
  }

  const uniqueSubdomains = Array.from(allSubdomains).sort();

  // Optionally resolve
  let resolved: Record<string, string[]> | undefined;
  if (resolve) {
    console.error(`[*] Resolving ${uniqueSubdomains.length} subdomains...`);
    resolved = await resolveSubdomains(uniqueSubdomains);
  }

  const duration = Date.now() - startTime;

  const result: ReconResult = {
    domain,
    subdomains: uniqueSubdomains,
    sources,
    resolved,
    stats: {
      total: subfinderResults.length + chaosResults.length + crtshResults.length,
      unique: uniqueSubdomains.length,
      bySource: {
        subfinder: subfinderResults.length,
        chaos: chaosResults.length,
        crtsh: crtshResults.length,
      },
      duration,
    },
  };

  // Capture recon results to MemoryStore
  if (uniqueSubdomains.length > 0) {
    await memoryStore.capture({
      type: "research",
      category: "DOMAIN_RECON",
      title: `Domain Recon - ${domain}`,
      content: JSON.stringify(result, null, 2),
      tags: [
        "recon",
        "subdomains",
        domain,
        `count-${uniqueSubdomains.length}`,
        `sources-${Object.keys(sources).length}`,
        ...(resolve ? ["resolved"] : []),
      ],
      tier: "warm",
      source: "SubdomainEnum",
    });
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Domain Recon: ${domain} ===\n`);
    console.log(`Subdomains (${uniqueSubdomains.length} unique):`);
    for (const sub of uniqueSubdomains) {
      if (resolved && resolved[sub]) {
        console.log(`  ${sub} → ${resolved[sub].join(", ")}`);
      } else {
        console.log(`  ${sub}`);
      }
    }
    console.log(`\nSources:`);
    console.log(`  subfinder: ${subfinderResults.length}`);
    console.log(`  chaos: ${chaosResults.length}`);
    console.log(`  crt.sh: ${crtshResults.length}`);
    console.log(`\nCompleted in ${(duration / 1000).toFixed(1)}s`);
  }
}

main();
