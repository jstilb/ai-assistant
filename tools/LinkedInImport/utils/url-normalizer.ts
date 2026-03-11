// LinkedIn URL Normalizer
// Canonical form: lowercase, strip trailing slash, remove query params, ensure https://www.linkedin.com/in/ prefix

export function normalizeLinkedInUrl(url: string): string {
  if (!url || url.trim() === "") return "";

  let normalized = url.trim().toLowerCase();

  // Add https:// if missing
  if (!normalized.startsWith("http")) {
    normalized = "https://" + normalized;
  }

  // Ensure https (not http)
  normalized = normalized.replace(/^http:\/\//, "https://");

  // Normalize www — ensure www.linkedin.com
  normalized = normalized.replace(
    /^https:\/\/linkedin\.com\//,
    "https://www.linkedin.com/"
  );

  try {
    const u = new URL(normalized);
    // Strip query params and hash
    u.search = "";
    u.hash = "";
    // Remove trailing slash from pathname
    let path = u.pathname.replace(/\/+$/, "");
    u.pathname = path;
    return u.toString().toLowerCase();
  } catch {
    // If URL parsing fails, do basic string manipulation
    // Strip query params
    const qIndex = normalized.indexOf("?");
    if (qIndex !== -1) normalized = normalized.substring(0, qIndex);
    // Strip hash
    const hIndex = normalized.indexOf("#");
    if (hIndex !== -1) normalized = normalized.substring(0, hIndex);
    // Strip trailing slash
    normalized = normalized.replace(/\/+$/, "");
    return normalized;
  }
}

// Extract the slug from a LinkedIn URL (the /in/slug part)
export function extractLinkedInSlug(url: string): string {
  const normalized = normalizeLinkedInUrl(url);
  const match = normalized.match(/\/in\/([^/]+)/);
  return match ? match[1] : "";
}

// Build URL index from nodes — returns Map<normalizedUrl, nodeIndex>
export function buildUrlIndex(nodes: Array<{ id: string; linkedinUrl: string }>): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (node.linkedinUrl) {
      const normalized = normalizeLinkedInUrl(node.linkedinUrl);
      if (normalized) {
        index.set(normalized, node.id);
        // Also index by slug for fuzzy matching
        const slug = extractLinkedInSlug(normalized);
        if (slug) {
          index.set(slug, node.id);
        }
      }
    }
  }
  return index;
}

// Match a URL to a node ID using normalized URL or slug fallback
export function matchUrlToNodeId(
  url: string,
  urlIndex: Map<string, string>
): string | null {
  if (!url || url.trim() === "") return null;

  const normalized = normalizeLinkedInUrl(url);
  if (urlIndex.has(normalized)) return urlIndex.get(normalized)!;

  // Slug fallback
  const slug = extractLinkedInSlug(normalized);
  if (slug && urlIndex.has(slug)) return urlIndex.get(slug)!;

  return null;
}
