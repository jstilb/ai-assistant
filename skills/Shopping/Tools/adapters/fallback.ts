/**
 * Tier 3 Fallback Adapter
 *
 * Generates curated search links for any retailer.
 * Zero credentials needed - always works.
 * This is the safety net when browser automation isn't available.
 */

import type { ShoppingListItem, ShoppingProfile } from './base'
import { logLinkGenerated } from '../security/audit'

/**
 * Known retailer URL patterns for search
 */
const RETAILER_SEARCH_URLS: Record<string, string> = {
  rei: 'https://www.rei.com/search?q=',
  patagonia: 'https://www.patagonia.com/search/?q=',
  arcteryx: 'https://arcteryx.com/us/en/search?q=',
  nordstrom: 'https://www.nordstrom.com/sr?keyword=',
  allbirds: 'https://www.allbirds.com/search?q=',
  everlane: 'https://www.everlane.com/search?q=',
  outlier: 'https://outlier.nyc/search?q=',
  target: 'https://www.target.com/s?searchTerm=',
  walmart: 'https://www.walmart.com/search?q=',
  costco: 'https://www.costco.com/CatalogSearch?keyword=',
  // Generic fallback uses Google Shopping
  _default: 'https://www.google.com/search?tbm=shop&q='
}

/**
 * Known retailer display names
 */
const RETAILER_NAMES: Record<string, string> = {
  rei: 'REI',
  patagonia: 'Patagonia',
  arcteryx: "Arc'teryx",
  nordstrom: 'Nordstrom',
  allbirds: 'Allbirds',
  everlane: 'Everlane',
  outlier: 'Outlier',
  target: 'Target',
  walmart: 'Walmart',
  costco: 'Costco'
}

export interface FallbackLink {
  item: ShoppingListItem
  url: string
  retailer: string
  retailerDisplay: string
  notes: string[]
}

export interface FallbackResult {
  links: FallbackLink[]
  byRetailer: Map<string, FallbackLink[]>
  markdown: string
}

/**
 * Generate search URL for a retailer
 */
function getSearchUrl(retailer: string, query: string): string {
  const baseUrl = RETAILER_SEARCH_URLS[retailer.toLowerCase()]
    || RETAILER_SEARCH_URLS._default

  // Add retailer name to query if using Google Shopping fallback
  const finalQuery = baseUrl === RETAILER_SEARCH_URLS._default
    ? `${retailer} ${query}`
    : query

  return baseUrl + encodeURIComponent(finalQuery)
}

/**
 * Get display name for retailer
 */
function getRetailerName(retailer: string): string {
  return RETAILER_NAMES[retailer.toLowerCase()] || retailer
}

/**
 * Infer retailer from product name or description
 */
export function inferRetailer(item: ShoppingListItem): string {
  const name = item.name.toLowerCase()

  // Check for brand mentions
  if (name.includes('patagonia')) return 'patagonia'
  if (name.includes('arcteryx') || name.includes("arc'teryx")) return 'arcteryx'
  if (name.includes('rei') || name.includes('co-op')) return 'rei'
  if (name.includes('allbirds')) return 'allbirds'
  if (name.includes('everlane')) return 'everlane'
  if (name.includes('outlier')) return 'outlier'
  if (name.includes('nordstrom')) return 'nordstrom'

  // Default to user's preferred store if available
  return item.retailer || 'rei'
}

/**
 * Generate notes about a purchase (gift cards, loyalty, etc.)
 */
function generateNotes(retailer: string, profile?: ShoppingProfile): string[] {
  const notes: string[] = []

  if (!profile) return notes

  // Check for gift cards
  const giftCard = profile.giftCards.find(
    gc => gc.store.toLowerCase() === retailer.toLowerCase()
  )
  if (giftCard) {
    notes.push(`You have a ${getRetailerName(retailer)} gift card${giftCard.balance ? ` ($${giftCard.balance})` : ''}`)
  }

  // Check for loyalty programs
  const loyalty = profile.loyaltyPrograms.find(
    lp => lp.store.toLowerCase() === retailer.toLowerCase()
  )
  if (loyalty) {
    notes.push(`${loyalty.benefits}`)
  }

  // Check if preferred store
  if (profile.preferredStores.map(s => s.toLowerCase()).includes(retailer.toLowerCase())) {
    notes.push('Preferred store')
  }

  return notes
}

/**
 * Build search query with size/color if specified
 */
function buildSearchQuery(item: ShoppingListItem): string {
  let query = item.name

  // Add size to query for clothing
  if (item.size) {
    query += ` ${item.size}`
  }

  // Add color if specified
  if (item.color) {
    query += ` ${item.color}`
  }

  return query
}

/**
 * Generate Tier 3 fallback links for a shopping list
 */
export async function generateFallbackLinks(
  items: ShoppingListItem[],
  profile?: ShoppingProfile
): Promise<FallbackResult> {
  const links: FallbackLink[] = []
  const byRetailer = new Map<string, FallbackLink[]>()

  for (const item of items) {
    const retailer = item.retailer || inferRetailer(item)
    const query = buildSearchQuery(item)
    const url = getSearchUrl(retailer, query)
    const notes = generateNotes(retailer, profile)

    const link: FallbackLink = {
      item,
      url,
      retailer: retailer.toLowerCase(),
      retailerDisplay: getRetailerName(retailer),
      notes
    }

    links.push(link)

    // Group by retailer
    if (!byRetailer.has(retailer)) {
      byRetailer.set(retailer, [])
    }
    byRetailer.get(retailer)!.push(link)

    // Audit log
    await logLinkGenerated(retailer, item.name, url)
  }

  // Generate markdown output
  const markdown = generateMarkdown(byRetailer, profile)

  return { links, byRetailer, markdown }
}

/**
 * Generate markdown output for shopping list
 */
function generateMarkdown(
  byRetailer: Map<string, FallbackLink[]>,
  profile?: ShoppingProfile
): string {
  const lines: string[] = ['## Shopping List: Ready to Add', '']

  for (const [retailer, links] of byRetailer) {
    const displayName = getRetailerName(retailer)
    const domain = RETAILER_SEARCH_URLS[retailer]
      ? new URL(RETAILER_SEARCH_URLS[retailer]).hostname
      : `${retailer}.com`

    lines.push(`### ${displayName} (${domain})`)
    lines.push('')

    for (const link of links) {
      // Item line with link
      let itemLine = `- [${link.item.name}](${link.url})`

      // Add size if specified
      if (link.item.size) {
        itemLine += ` - Size: ${link.item.size}`
      }

      // Add quantity if > 1
      if (link.item.quantity && link.item.quantity > 1) {
        itemLine += ` (qty: ${link.item.quantity})`
      }

      lines.push(itemLine)

      // Add notes as sub-items
      for (const note of link.notes) {
        lines.push(`  - *${note}*`)
      }
    }

    lines.push('')
  }

  // Footer
  lines.push('---')
  lines.push('')
  lines.push('**Click links to add to cart manually.**')

  // Check if any retailers have Tier 2 available
  const tier2Retailers = ['rei', 'instacart']
  const availableTier2 = [...byRetailer.keys()].filter(r =>
    tier2Retailers.includes(r.toLowerCase())
  )

  if (availableTier2.length > 0) {
    lines.push('')
    lines.push(`*Browser automation available for: ${availableTier2.map(r => getRetailerName(r)).join(', ')}*`)
    lines.push(`*Run \`shopping <retailer> add "<item>"\` to automate.*`)
  }

  return lines.join('\n')
}

/**
 * Parse a natural language shopping list into items
 */
export function parseShoppingList(input: string): ShoppingListItem[] {
  const items: ShoppingListItem[] = []

  // Split by newlines, commas, or bullet points
  const lines = input
    .split(/[\n,]/)
    .map(l => l.replace(/^[\s\-\*\d\.]+/, '').trim())
    .filter(l => l.length > 0)

  for (const line of lines) {
    // Try to extract quantity (e.g., "2x hiking socks" or "hiking socks x2")
    let quantity = 1
    let name = line

    const qtyMatch = line.match(/^(\d+)x?\s+(.+)$/) || line.match(/^(.+)\s+x(\d+)$/i)
    if (qtyMatch) {
      quantity = parseInt(qtyMatch[1], 10) || parseInt(qtyMatch[2], 10) || 1
      name = qtyMatch[2] || qtyMatch[1]
    }

    // Try to extract retailer prefix (e.g., "REI: hiking socks")
    let retailer: string | undefined
    const retailerMatch = name.match(/^(\w+):\s*(.+)$/)
    if (retailerMatch) {
      const possibleRetailer = retailerMatch[1].toLowerCase()
      if (RETAILER_SEARCH_URLS[possibleRetailer]) {
        retailer = possibleRetailer
        name = retailerMatch[2]
      }
    }

    // Try to extract size (e.g., "sweater (M)" or "sweater size M")
    let size: string | undefined
    const sizeMatch = name.match(/\(([XSML]+|[\d\.]+)\)$/i)
      || name.match(/size\s+([XSML]+|[\d\.]+)$/i)
    if (sizeMatch) {
      size = sizeMatch[1].toUpperCase()
      name = name.replace(sizeMatch[0], '').trim()
    }

    items.push({
      name: name.trim(),
      quantity,
      size,
      retailer
    })
  }

  return items
}
