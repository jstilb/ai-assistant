#!/usr/bin/env bun

/**
 * IPInfo API Client
 *
 * Wrapper for ipinfo.io API with error handling, rate limiting, and caching.
 * Requires IPINFO_API_KEY environment variable.
 *
 * Uses CORE CachedHTTPClient for persistent disk caching with 7-day TTL.
 *
 * Usage:
 *   const client = new IPInfoClient();
 *   const info = await client.lookup("1.2.3.4");
 *   console.log(info.organization, info.location);
 */

import { createHTTPClient, type CachedHTTPClient } from "../../CORE/Tools/CachedHTTPClient.ts";
import { memoryStore } from "../../CORE/Tools/MemoryStore.ts";

// Initialize HTTP client with 7-day cache for IP lookups
const ipInfoHttpClient: CachedHTTPClient = createHTTPClient({
  cacheDir: `${process.env.HOME}/.claude/.cache/ipinfo`,
  defaultTtl: 7 * 24 * 60 * 60, // 7 days
});

export interface IPInfoResponse {
  ip: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string; // "latitude,longitude"
  postal?: string;
  timezone?: string;
  asn?: {
    asn: string; // "AS15169"
    name: string; // "Google LLC"
    domain: string; // "google.com"
    route: string; // "8.8.8.0/24"
    type: string; // "business" | "hosting" | "isp" | "education"
  };
  company?: {
    name: string;
    domain: string;
    type: string;
  };
  privacy?: {
    vpn: boolean;
    proxy: boolean;
    tor: boolean;
    relay: boolean;
    hosting: boolean;
  };
  abuse?: {
    address: string;
    country: string;
    email: string;
    name: string;
    network: string;
    phone: string;
  };
}

export interface IPInfoBatchResponse {
  [ip: string]: IPInfoResponse;
}

export class IPInfoClient {
  private apiKey: string;
  private baseUrl = "https://ipinfo.io";
  private lastRequestTime = 0;
  private minRequestInterval = 100; // ms between requests (10 req/sec)

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.IPINFO_API_KEY || "";

    if (!this.apiKey) {
      throw new Error(
        "IPInfo API key not found. Set IPINFO_API_KEY environment variable."
      );
    }
  }

  /**
   * Lookup single IP address
   * Uses CORE CachedHTTPClient for persistent 7-day disk caching.
   */
  async lookup(ip: string): Promise<IPInfoResponse> {
    // Rate limiting (still needed even with caching for cache misses)
    await this.rateLimit();

    const url = `${this.baseUrl}/${ip}/json?token=${this.apiKey}`;

    try {
      // Use CachedHTTPClient with disk cache
      const data = await ipInfoHttpClient.fetchJson<IPInfoResponse>(url, {
        cache: 'disk',
        ttl: 7 * 24 * 60 * 60, // 7 days
        retry: 2,
      });

      return data;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('429')) {
          throw new Error("IPInfo API rate limit exceeded");
        }
        if (error.message.includes('401')) {
          throw new Error("Invalid IPInfo API key");
        }
        throw new Error(`IPInfo lookup failed for ${ip}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Batch lookup multiple IPs
   * Uses individual lookups to leverage CachedHTTPClient disk caching.
   */
  async batchLookup(ips: string[]): Promise<IPInfoBatchResponse> {
    if (ips.length === 0) {
      return {};
    }

    const result: IPInfoBatchResponse = {};

    // Use individual lookups - CachedHTTPClient handles disk caching
    for (const ip of ips) {
      try {
        result[ip] = await this.lookup(ip);
      } catch (error) {
        console.error(`Failed to lookup ${ip}:`, error);
      }
    }

    return result;
  }

  /**
   * Get geolocation info
   */
  async getLocation(ip: string): Promise<{
    city: string;
    region: string;
    country: string;
    latitude: number;
    longitude: number;
  } | null> {
    const info = await this.lookup(ip);

    if (!info.city || !info.region || !info.country || !info.loc) {
      return null;
    }

    const [lat, lon] = info.loc.split(",").map(Number);

    return {
      city: info.city,
      region: info.region,
      country: info.country,
      latitude: lat,
      longitude: lon,
    };
  }

  /**
   * Get ASN info
   */
  async getASN(ip: string): Promise<{
    asn: string;
    name: string;
    route: string;
    type: string;
  } | null> {
    const info = await this.lookup(ip);

    if (!info.asn) {
      return null;
    }

    return {
      asn: info.asn.asn,
      name: info.asn.name,
      route: info.asn.route,
      type: info.asn.type,
    };
  }

  /**
   * Get organization info
   */
  async getOrganization(ip: string): Promise<{
    name: string;
    domain: string;
    type: string;
  } | null> {
    const info = await this.lookup(ip);

    if (!info.company) {
      return null;
    }

    return {
      name: info.company.name,
      domain: info.company.domain,
      type: info.company.type,
    };
  }

  /**
   * Check if IP is VPN/Proxy/Tor
   */
  async isProxy(ip: string): Promise<{
    isProxy: boolean;
    vpn: boolean;
    proxy: boolean;
    tor: boolean;
    relay: boolean;
    hosting: boolean;
  }> {
    const info = await this.lookup(ip);

    if (!info.privacy) {
      return {
        isProxy: false,
        vpn: false,
        proxy: false,
        tor: false,
        relay: false,
        hosting: false,
      };
    }

    return {
      isProxy:
        info.privacy.vpn ||
        info.privacy.proxy ||
        info.privacy.tor ||
        info.privacy.relay,
      vpn: info.privacy.vpn,
      proxy: info.privacy.proxy,
      tor: info.privacy.tor,
      relay: info.privacy.relay,
      hosting: info.privacy.hosting,
    };
  }

  /**
   * Get abuse contact
   */
  async getAbuseContact(ip: string): Promise<{
    email: string;
    phone: string;
    name: string;
    network: string;
  } | null> {
    const info = await this.lookup(ip);

    if (!info.abuse) {
      return null;
    }

    return {
      email: info.abuse.email,
      phone: info.abuse.phone,
      name: info.abuse.name,
      network: info.abuse.network,
    };
  }

  /**
   * Rate limiting helper
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;

    if (elapsed < this.minRequestInterval) {
      const delay = this.minRequestInterval - elapsed;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Clear cache (delegates to CORE CachedHTTPClient)
   */
  clearCache(): void {
    ipInfoHttpClient.clearCache('ipinfo.io');
  }

  /**
   * Get cache stats (delegates to CORE CachedHTTPClient)
   */
  getCacheStats(): { hits: number; misses: number; size: number } {
    return ipInfoHttpClient.getCacheStats();
  }
}

/**
 * CLI usage
 */
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: ipinfo-client.ts <ip> [ip2 ip3 ...]");
    console.log("       IPINFO_API_KEY=xxx ipinfo-client.ts 1.2.3.4");
    process.exit(1);
  }

  const client = new IPInfoClient();

  if (args.length === 1) {
    // Single lookup
    const info = await client.lookup(args[0]);
    console.log(JSON.stringify(info, null, 2));

    // Capture IP intel to MemoryStore
    const ip = args[0];
    const tags = ["ipinfo", ip];
    if (info.asn?.name) tags.push(info.asn.name.toLowerCase().replace(/\s+/g, '-'));
    if (info.country) tags.push(info.country.toLowerCase());
    if (info.privacy?.vpn) tags.push("vpn");
    if (info.privacy?.tor) tags.push("tor");
    if (info.privacy?.proxy) tags.push("proxy");

    await memoryStore.capture({
      type: "research",
      category: "IP_INTEL",
      title: `IP Intelligence - ${ip}`,
      content: JSON.stringify(info, null, 2),
      tags,
      tier: "warm",
      source: "IpinfoClient",
    });
  } else {
    // Batch lookup
    const results = await client.batchLookup(args);
    console.log(JSON.stringify(results, null, 2));

    // Capture batch IP intel to MemoryStore
    const ipCount = Object.keys(results).length;
    await memoryStore.capture({
      type: "research",
      category: "IP_INTEL_BATCH",
      title: `IP Intelligence Batch - ${ipCount} IPs`,
      content: JSON.stringify(results, null, 2),
      tags: ["ipinfo", "batch", `count-${ipCount}`, ...args.slice(0, 5)],
      tier: "warm",
      source: "IpinfoClient",
    });
  }
}
