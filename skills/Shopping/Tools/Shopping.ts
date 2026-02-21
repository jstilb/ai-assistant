#!/usr/bin/env bun
/**
 * Shopping CLI Tool v2.0.0
 *
 * Universal shopping automation - works with ANY e-commerce site.
 * Uses AI-vision-based navigation instead of site-specific selectors.
 *
 * Usage:
 *   # Tier 3: Generate links for any retailer
 *   bun run Shopping.ts list "REI: hiking pack, Patagonia: fleece (M)"
 *
 *   # Tier 2: Browser automation for ANY retailer
 *   bun run Shopping.ts <retailer> login      # Login and save session
 *   bun run Shopping.ts <retailer> add "item" # Add to cart
 *   bun run Shopping.ts <retailer> cart       # View cart
 *   bun run Shopping.ts <retailer> status     # Check session
 *
 * Examples:
 *   bun run Shopping.ts rei add "Flash 22 Pack"
 *   bun run Shopping.ts patagonia add "Better Sweater" --size M
 *   bun run Shopping.ts nordstrom add "dress shoes" --size 8
 *
 * Security:
 *   - No auto-checkout (constitutional)
 *   - Visual verification before cart ops
 *   - Audit logging to MEMORY/shopping-audit.jsonl
 */

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import {
  createShoppingAdapter,
  getKnownRetailers,
  type ShoppingItem
} from './adapters/generic'
import {
  generateFallbackLinks,
  parseShoppingList,
  inferRetailer
} from './adapters/fallback'
import type { ShoppingProfile } from './adapters/base'

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), '.claude')
const SHOPPING_PROFILE = join(KAYA_HOME, 'skills/Shopping/ShoppingProfile.md')

// ============================================
// PROFILE LOADING
// ============================================

async function loadShoppingProfile(): Promise<ShoppingProfile | undefined> {
  try {
    if (!existsSync(SHOPPING_PROFILE)) return undefined

    const content = await readFile(SHOPPING_PROFILE, 'utf-8')

    // Parse basic info from markdown
    const profile: ShoppingProfile = {
      sizes: { tops: 'M', bottoms: '30', shoes: '8' },
      giftCards: [],
      preferredStores: [],
      excludedBrands: [],
      loyaltyPrograms: []
    }

    // Extract sizes
    const topsMatch = content.match(/T-shirts?\s*\|\s*(\w+)/i)
    if (topsMatch) profile.sizes.tops = topsMatch[1]

    const bottomsMatch = content.match(/Jeans?\s*\|\s*([\d\/x]+)/i)
    if (bottomsMatch) profile.sizes.bottoms = bottomsMatch[1]

    const shoesMatch = content.match(/Sneakers?\s*\|\s*([\d\.]+)/i)
    if (shoesMatch) profile.sizes.shoes = shoesMatch[1]

    // Extract gift cards
    const giftCardSection = content.match(/### Active Gift Cards[\s\S]*?\n\n/i)
    if (giftCardSection) {
      const reiGC = content.match(/REI\s*\|\s*\$?([\d,TBD]+)/i)
      if (reiGC) profile.giftCards.push({ store: 'REI', balance: reiGC[1] })

      const nordstromGC = content.match(/Nordstrom\s*\|\s*\$?([\d,TBD]+)/i)
      if (nordstromGC) profile.giftCards.push({ store: 'Nordstrom', balance: nordstromGC[1] })
    }

    // Extract loyalty programs
    if (content.includes('REI Co-op') && content.includes('Member')) {
      profile.loyaltyPrograms.push({
        store: 'REI',
        benefits: 'REI Co-op Member (10% annual dividend)'
      })
    }

    // Extract preferred stores
    const preferredMatch = content.match(/Preferred\s*\|\s*([^\n]+)/i)
    if (preferredMatch) {
      profile.preferredStores = preferredMatch[1]
        .split(',')
        .map(s => s.trim().toLowerCase())
    }

    return profile
  } catch {
    return undefined
  }
}

// ============================================
// SIZE DETECTION
// ============================================

/**
 * Infer clothing size from item name using profile data.
 * Returns the appropriate size (tops/bottoms/shoes) based on keywords in the name.
 */
function inferSizeFromProfile(itemName: string, profile?: ShoppingProfile): string | undefined {
  if (!profile) return undefined
  const name = itemName.toLowerCase()
  if (name.includes('shirt') || name.includes('sweater') || name.includes('fleece') || name.includes('jacket')) {
    return profile.sizes.tops
  } else if (name.includes('pants') || name.includes('jeans') || name.includes('shorts')) {
    return profile.sizes.bottoms
  } else if (name.includes('shoes') || name.includes('boots') || name.includes('sneakers')) {
    return profile.sizes.shoes
  }
  return undefined
}

// ============================================
// COMMANDS
// ============================================

async function handleList(args: string[]): Promise<void> {
  const input = args.join(' ')

  if (!input) {
    console.error('Please provide a shopping list')
    console.log('Example: bun run Shopping.ts list "REI: hiking pack, Patagonia: fleece (M)"')
    process.exit(1)
  }

  console.log('\n📝 Processing shopping list...\n')

  // Load profile for sizes and preferences
  const profile = await loadShoppingProfile()
  if (profile) {
    console.log(`👤 Loaded profile: sizes=${profile.sizes.tops}, gift cards=${profile.giftCards.length}`)
  }

  // Parse the list
  const items = parseShoppingList(input)

  // Apply profile sizes to items without explicit size
  for (const item of items) {
    if (!item.size) {
      item.size = inferSizeFromProfile(item.name, profile)
    }
  }

  // Generate Tier 3 fallback links
  const result = await generateFallbackLinks(items, profile)

  // Output markdown
  console.log(result.markdown)

  // Show automation option
  console.log('\n---')
  console.log('\n🤖 **Browser automation available for any retailer:**')
  console.log('   bun run Shopping.ts <retailer> add "<item>" --size <size>')
  console.log('\n   Examples:')
  for (const item of items.slice(0, 3)) {
    const retailer = item.retailer || inferRetailer(item)
    const sizeArg = item.size ? ` --size ${item.size}` : ''
    console.log(`   bun run Shopping.ts ${retailer} add "${item.name}"${sizeArg}`)
  }
}

async function handleRetailer(retailer: string, command: string, args: string[]): Promise<void> {
  const adapter = createShoppingAdapter(retailer)

  switch (command) {
    case 'login':
      await adapter.login()
      break

    case 'add': {
      // Parse item from args
      const cleanArgs: string[] = []
      let size: string | undefined
      let quantity = 1

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--size' && args[i + 1]) {
          size = args[i + 1]
          i++
        } else if (args[i] === '--qty' && args[i + 1]) {
          quantity = parseInt(args[i + 1], 10) || 1
          i++
        } else if (!args[i].startsWith('--')) {
          cleanArgs.push(args[i])
        }
      }

      const itemName = cleanArgs.join(' ')
      if (!itemName) {
        console.error('Please specify an item to add')
        console.log(`Example: bun run Shopping.ts ${retailer} add "hiking pack" --size M`)
        process.exit(1)
      }

      // Load profile for default size
      if (!size) {
        const profile = await loadShoppingProfile()
        size = inferSizeFromProfile(itemName, profile)
      }

      const item: ShoppingItem = {
        name: itemName,
        size,
        quantity
      }

      await adapter.addToCart(item)
      break
    }

    case 'cart':
      await adapter.viewCart()
      break

    case 'status': {
      const hasSession = await adapter.checkSession()
      if (hasSession) {
        console.log(`✅ ${retailer} session exists`)
        console.log(`   Run '${retailer} cart' to verify it's still valid`)
      } else {
        console.log(`❌ No saved session for ${retailer}`)
        console.log(`   Run: bun run Shopping.ts ${retailer} login`)
      }
      break
    }

    case 'logout': {
      const { unlink } = await import('fs/promises')
      const sessionPath = join(KAYA_HOME, 'skills/Shopping/Tools/.sessions', `${retailer}-session.json`)
      if (existsSync(sessionPath)) {
        await unlink(sessionPath)
        console.log(`✅ ${retailer} session cleared`)
      } else {
        console.log(`ℹ️ No session to clear for ${retailer}`)
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.log(`Available: login, add, cart, status, logout`)
      process.exit(1)
  }
}

// ============================================
// MAIN
// ============================================

function showHelp(): void {
  const knownRetailers = getKnownRetailers()

  console.log(`
Shopping CLI v2.0.0 - Universal Shopping Automation

TIER 3 - Generate Links (Universal):
  bun run Shopping.ts list "<shopping list>"

  Examples:
    bun run Shopping.ts list "REI: hiking pack, Patagonia: fleece"
    bun run Shopping.ts list "running shoes (8), rain jacket (M)"

TIER 2 - Browser Automation (ANY Retailer):
  bun run Shopping.ts <retailer> login         Login and save session
  bun run Shopping.ts <retailer> add "<item>"  Add item to cart
  bun run Shopping.ts <retailer> add "item" --size M --qty 2
  bun run Shopping.ts <retailer> cart          View current cart
  bun run Shopping.ts <retailer> status        Check session validity
  bun run Shopping.ts <retailer> logout        Clear saved session

  Examples:
    bun run Shopping.ts rei add "Flash 22 Pack"
    bun run Shopping.ts patagonia add "Better Sweater" --size M
    bun run Shopping.ts nordstrom add "dress shoes" --size 8
    bun run Shopping.ts arcteryx add "Atom LT Hoody" --size M

Known Retailers (with optimized URLs):
  ${knownRetailers.join(', ')}

Works with ANY retailer - just use the domain name:
  bun run Shopping.ts uniqlo add "heattech shirt"
  bun run Shopping.ts cotopaxi add "Fuego Down Jacket"

Security:
  - No auto-checkout (requires manual user action)
  - Visual verification before cart operations
  - All actions logged to MEMORY/shopping-audit.jsonl

Profile:
  User sizes and preferences loaded from:
  ${SHOPPING_PROFILE}
`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp()
    return
  }

  try {
    if (command === 'list') {
      await handleList(args.slice(1))
    } else {
      // Treat first arg as retailer name
      const retailer = command.toLowerCase()
      const subCommand = args[1] || 'help'
      const subArgs = args.slice(2)

      if (subCommand === 'help') {
        console.log(`\n${retailer} Commands:`)
        console.log(`  login   - Login and save session`)
        console.log(`  add     - Add item to cart`)
        console.log(`  cart    - View current cart`)
        console.log(`  status  - Check session validity`)
        console.log(`  logout  - Clear saved session`)
        console.log(`\nExample:`)
        console.log(`  bun run Shopping.ts ${retailer} add "product name" --size M`)
        return
      }

      await handleRetailer(retailer, subCommand, subArgs)
    }
  } catch (err: any) {
    console.error(`❌ Error: ${err.message}`)
    process.exit(1)
  }
}

main()
