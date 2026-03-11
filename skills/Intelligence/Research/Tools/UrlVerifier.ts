#!/usr/bin/env bun

/**
 * URL Verification Tool - Prevents hallucinated link delivery
 *
 * Validates URLs before including them in research output.
 * Critical for research quality - LLMs frequently hallucinate URLs.
 *
 * Usage:
 *   bun ~/.claude/skills/Intelligence/Research/Tools/UrlVerifier.ts "https://example.com"
 *   echo '["url1", "url2"]' | bun ~/.claude/skills/Intelligence/Research/Tools/UrlVerifier.ts --batch
 *
 * Returns:
 *   JSON with verification status for each URL
 */

import { createHTTPClient } from '../../../../lib/core/CachedHTTPClient.ts';

const client = createHTTPClient({
  defaultTtl: 60,
  maxRetries: 1,
});

interface VerificationResult {
  url: string;
  valid: boolean;
  httpStatus?: number;
  error?: string;
  httpAccessible?: boolean;
  verifiedAt: string;
}

async function verifyUrl(url: string): Promise<VerificationResult> {
  const result: VerificationResult = {
    url,
    valid: false,
    verifiedAt: new Date().toISOString()
  };

  try {
    // Step 1: HTTP HEAD request to check status via CachedHTTPClient
    const response = await client.fetch(url, {
      cache: 'none',
      timeout: 10000,
      retry: 0,
      headers: { 'Accept': '*/*' }
    });

    result.httpStatus = response.status;

    if (response.ok) {
      result.valid = true;
      result.httpAccessible = true;
    } else if (response.status === 405) {
      // Some servers don't support HEAD, try GET via CachedHTTPClient
      const getResponse = await client.fetch(url, {
        cache: 'none',
        timeout: 15000,
        retry: 0,
      });
      result.httpStatus = getResponse.status;
      result.valid = getResponse.ok;
      result.httpAccessible = getResponse.ok;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.valid = false;
  }

  return result;
}

const BATCH_CONCURRENCY = 5;

async function verifyBatch(urls: string[]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Process in batches of BATCH_CONCURRENCY to avoid hammering servers
  for (let i = 0; i < urls.length; i += BATCH_CONCURRENCY) {
    const batch = urls.slice(i, i + BATCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(verifyUrl));
    results.push(...batchResults);
  }

  return results;
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  bun UrlVerifier.ts "https://example.com"');
  console.error('  echo \'["url1", "url2"]\' | bun UrlVerifier.ts --batch');
  process.exit(1);
}

if (args[0] === '--batch') {
  // Read URLs from stdin with error handling
  const input = await Bun.stdin.text();
  let urls: string[];
  try {
    urls = JSON.parse(input);
    if (!Array.isArray(urls)) {
      throw new Error('Expected JSON array of URL strings');
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: 'Invalid JSON input for batch mode',
      detail: error instanceof Error ? error.message : String(error),
      expected: '["url1", "url2", ...]'
    }, null, 2));
    process.exit(1);
  }
  const results = await verifyBatch(urls);
  console.log(JSON.stringify({
    total: urls.length,
    valid: results.filter(r => r.valid).length,
    invalid: results.filter(r => !r.valid).length,
    results
  }, null, 2));
} else {
  // Single URL verification
  const result = await verifyUrl(args[0]);
  console.log(JSON.stringify(result, null, 2));
}
