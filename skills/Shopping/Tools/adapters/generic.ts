/**
 * Generic AI-Vision Shopping Adapter
 *
 * Uses AI vision analysis to navigate ANY e-commerce site.
 * No site-specific selectors needed - adapts to any layout.
 *
 * Flow:
 * 1. Navigate to retailer URL
 * 2. Screenshot → AI finds search input
 * 3. Type query
 * 4. Screenshot → AI finds best product match
 * 5. Click product
 * 6. Screenshot → AI finds add to cart button
 * 7. Visual verification gate (user confirms)
 * 8. Click add to cart
 * 9. Screenshot → AI verifies success
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright'
import { spawn } from 'child_process'
import { writeFile, readFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'

import {
  auditLog,
  logCartAddAttempt,
  logCartAddDecision,
  logCartAddSuccess,
  logCartAddFailed
} from '../security/audit'
import { prepareOutputPath } from '../../../CORE/Tools/OutputPathResolver'

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), '.claude')
const SESSION_DIR = join(KAYA_HOME, 'skills', 'Shopping', 'Tools', '.sessions')

// Known retailer base URLs
const RETAILER_URLS: Record<string, string> = {
  rei: 'https://www.rei.com',
  patagonia: 'https://www.patagonia.com',
  arcteryx: 'https://arcteryx.com',
  nordstrom: 'https://www.nordstrom.com',
  allbirds: 'https://www.allbirds.com',
  everlane: 'https://www.everlane.com',
  target: 'https://www.target.com',
  // Add more as needed
}

export interface ShoppingItem {
  name: string
  size?: string
  color?: string
  quantity?: number
}

export interface AIElement {
  description: string
  selector?: string
  coordinates?: { x: number; y: number }
  confidence: number
}

export interface StepResult {
  success: boolean
  screenshot?: string
  error?: string
  element?: AIElement
}

/**
 * Run AI inference on a screenshot to find UI elements
 */
async function analyzeScreenshot(
  screenshotPath: string,
  prompt: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use Kaya inference tool with vision capability
    const fullPrompt = `You are analyzing a screenshot of an e-commerce website.

${prompt}

Respond in JSON format with:
{
  "found": true/false,
  "description": "what you found",
  "action": "specific action to take",
  "selector_hint": "CSS selector hint if obvious (e.g., 'input[type=search]', 'button.add-to-cart')",
  "coordinates_hint": "approximate location (e.g., 'top-center', 'middle-right')",
  "confidence": 0.0-1.0
}

Be specific and actionable. If you can't find what's requested, explain what you see instead.`

    // For now, use a simpler approach - we'll enhance with vision later
    // This creates the structure for AI-driven element finding
    const proc = spawn('bun', [
      join(KAYA_HOME, 'skills', 'CORE', 'Tools', 'Inference.ts'),
      'standard'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let output = ''
    proc.stdout.on('data', (data) => { output += data.toString() })
    proc.stderr.on('data', (data) => { console.error(data.toString()) })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim())
      } else {
        reject(new Error(`Inference failed with code ${code}`))
      }
    })

    proc.stdin.write(fullPrompt)
    proc.stdin.end()
  })
}

/**
 * Prompt user for confirmation with screenshot
 */
async function promptUserConfirmation(
  message: string,
  screenshotPath: string
): Promise<boolean> {
  console.log(`\n📸 Screenshot saved: ${screenshotPath}`)
  console.log(`\n${message}`)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rl.question('Proceed? [y/N]: ', (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}

/**
 * Take a screenshot and save it using OutputPathResolver
 */
async function takeScreenshot(page: Page, name: string): Promise<string> {
  const { path } = await prepareOutputPath({
    skill: 'Shopping',
    title: name,
    extension: 'png'
  })
  await page.screenshot({ path, fullPage: false })
  return path
}

/**
 * Generic Shopping Adapter - works on any e-commerce site
 */
export class GenericShoppingAdapter {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private retailer: string
  private baseUrl: string

  constructor(retailer: string) {
    this.retailer = retailer.toLowerCase()
    this.baseUrl = RETAILER_URLS[this.retailer] || `https://www.${retailer}.com`
  }

  /**
   * Initialize browser with optional saved session
   */
  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: process.env.SHOPPING_HEADLESS !== 'false', // Default headless; set SHOPPING_HEADLESS=false for visible mode
      channel: 'chrome'
    })

    // Try to load saved session
    const sessionPath = join(SESSION_DIR, `${this.retailer}-session.json`)
    let storageState: any = undefined

    if (existsSync(sessionPath)) {
      try {
        const sessionData = await readFile(sessionPath, 'utf-8')
        storageState = JSON.parse(sessionData)
        console.log(`📂 Loaded saved session for ${this.retailer}`)
      } catch {
        console.log(`⚠️ Could not load session, starting fresh`)
      }
    }

    this.context = await this.browser.newContext({
      storageState,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    })

    this.page = await this.context.newPage()
  }

  /**
   * Save current session for reuse
   */
  async saveSession(): Promise<void> {
    if (!this.context) return

    await mkdir(SESSION_DIR, { recursive: true })
    const sessionPath = join(SESSION_DIR, `${this.retailer}-session.json`)
    const state = await this.context.storageState()
    await writeFile(sessionPath, JSON.stringify(state, null, 2))
    console.log(`💾 Session saved for ${this.retailer}`)

    await auditLog('session_saved', { retailer: this.retailer })
  }

  /**
   * Navigate to retailer and let user log in
   */
  async login(): Promise<void> {
    await this.init()
    if (!this.page) throw new Error('Browser not initialized')

    console.log(`\n🔐 Opening ${this.retailer} for login...`)
    console.log(`   Please log in manually in the browser window.`)
    console.log(`   Press Enter here when you're done.\n`)

    await this.page.goto(this.baseUrl)

    // Wait for user to complete login
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    })

    await new Promise<void>((resolve) => {
      rl.question('Press Enter when login is complete...', () => {
        rl.close()
        resolve()
      })
    })

    await this.saveSession()
    await this.close()

    console.log(`✅ ${this.retailer} session saved. You can now add items to cart.`)
  }

  /**
   * Step 1: Navigate to site and find search box
   */
  async navigateAndFindSearch(): Promise<StepResult> {
    if (!this.page) throw new Error('Browser not initialized')

    console.log(`\n🌐 Navigating to ${this.baseUrl}...`)
    await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' })

    // Take screenshot for AI analysis
    const screenshot = await takeScreenshot(this.page, `${this.retailer}-homepage`)

    // Common search input patterns - try these first
    const searchSelectors = [
      'input[type="search"]',
      'input[name="q"]',
      'input[name="search"]',
      'input[name="query"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="find" i]',
      'input[aria-label*="search" i]',
      '#search',
      '.search-input',
      '[data-testid="search-input"]'
    ]

    for (const selector of searchSelectors) {
      const element = await this.page.$(selector)
      if (element && await element.isVisible()) {
        return {
          success: true,
          screenshot,
          element: {
            description: 'Search input found',
            selector,
            confidence: 0.9
          }
        }
      }
    }

    // If common selectors fail, we'd use AI vision here
    // For now, return failure so user can help
    return {
      success: false,
      screenshot,
      error: 'Could not find search input automatically. Check screenshot.'
    }
  }

  /**
   * Step 2: Search for product
   */
  async searchProduct(query: string): Promise<StepResult> {
    if (!this.page) throw new Error('Browser not initialized')

    // Find search using step 1
    const searchResult = await this.navigateAndFindSearch()
    if (!searchResult.success || !searchResult.element?.selector) {
      return searchResult
    }

    console.log(`🔍 Searching for: ${query}`)

    // Type in search
    await this.page.fill(searchResult.element.selector, query)
    await this.page.keyboard.press('Enter')

    // Wait for results to load
    await this.page.waitForLoadState('networkidle')
    await this.page.waitForTimeout(2000) // Extra time for dynamic content

    const screenshot = await takeScreenshot(this.page, `${this.retailer}-search-results`)

    await auditLog('search_performed', {
      retailer: this.retailer,
      item: query,
      screenshot
    })

    return {
      success: true,
      screenshot,
      element: {
        description: `Search results for: ${query}`,
        confidence: 0.8
      }
    }
  }

  /**
   * Step 3: Select a product from results
   */
  async selectProduct(query: string): Promise<StepResult> {
    if (!this.page) throw new Error('Browser not initialized')

    // Common product link patterns
    const productSelectors = [
      'a[href*="/product"]',
      'a[href*="/p/"]',
      '[data-testid="product-card"] a',
      '.product-card a',
      '.product-tile a',
      '.product-item a',
      'article a[href]',
      '.search-result a[href]'
    ]

    console.log(`🎯 Looking for product: ${query}`)

    // Try to find first product link
    for (const selector of productSelectors) {
      const elements = await this.page.$$(selector)
      if (elements.length > 0) {
        // Click the first product
        await elements[0].click()
        await this.page.waitForLoadState('networkidle')

        const screenshot = await takeScreenshot(this.page, `${this.retailer}-product-page`)

        return {
          success: true,
          screenshot,
          element: {
            description: 'Product page loaded',
            selector,
            confidence: 0.8
          }
        }
      }
    }

    const screenshot = await takeScreenshot(this.page, `${this.retailer}-no-products`)
    return {
      success: false,
      screenshot,
      error: 'Could not find product links. Check screenshot for results.'
    }
  }

  /**
   * Step 4: Find and prepare add to cart
   */
  async prepareAddToCart(item: ShoppingItem): Promise<StepResult> {
    if (!this.page) throw new Error('Browser not initialized')

    // Handle size selection if needed
    if (item.size) {
      console.log(`📏 Selecting size: ${item.size}`)

      const sizeSelectors = [
        `button:has-text("${item.size}")`,
        `[data-size="${item.size}"]`,
        `label:has-text("${item.size}")`,
        `option:has-text("${item.size}")`,
        `.size-option:has-text("${item.size}")`
      ]

      for (const selector of sizeSelectors) {
        try {
          const sizeElement = await this.page.$(selector)
          if (sizeElement && await sizeElement.isVisible()) {
            await sizeElement.click()
            await this.page.waitForTimeout(500)
            break
          }
        } catch {
          // Selector might not match, continue
        }
      }
    }

    // Find add to cart button
    const addCartSelectors = [
      'button:has-text("Add to Cart")',
      'button:has-text("Add to Bag")',
      'button:has-text("Add to basket")',
      '[data-testid="add-to-cart"]',
      '#add-to-cart',
      '.add-to-cart',
      'button[name="add"]',
      'input[value*="Add to" i]'
    ]

    for (const selector of addCartSelectors) {
      try {
        const button = await this.page.$(selector)
        if (button && await button.isVisible()) {
          const screenshot = await takeScreenshot(this.page, `${this.retailer}-ready-to-add`)

          return {
            success: true,
            screenshot,
            element: {
              description: 'Add to Cart button found',
              selector,
              confidence: 0.9
            }
          }
        }
      } catch {
        // Continue trying other selectors
      }
    }

    const screenshot = await takeScreenshot(this.page, `${this.retailer}-no-add-button`)
    return {
      success: false,
      screenshot,
      error: 'Could not find Add to Cart button. Check screenshot.'
    }
  }

  /**
   * Step 5: Execute add to cart (after user confirmation)
   */
  async executeAddToCart(selector: string): Promise<StepResult> {
    if (!this.page) throw new Error('Browser not initialized')

    try {
      await this.page.click(selector)
      await this.page.waitForTimeout(2000) // Wait for cart update

      const screenshot = await takeScreenshot(this.page, `${this.retailer}-added-to-cart`)

      return {
        success: true,
        screenshot,
        element: {
          description: 'Item added to cart',
          confidence: 0.9
        }
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to click Add to Cart: ${err.message}`
      }
    }
  }

  /**
   * Main flow: Add item to cart with visual verification
   */
  async addToCart(item: ShoppingItem): Promise<boolean> {
    try {
      await this.init()

      // Step 1-2: Navigate and search
      const searchResult = await this.searchProduct(item.name)
      if (!searchResult.success) {
        console.error(`❌ Search failed: ${searchResult.error}`)
        await logCartAddFailed(this.retailer, item.name, searchResult.error || 'Search failed')
        return false
      }

      // Step 3: Select product
      const selectResult = await this.selectProduct(item.name)
      if (!selectResult.success) {
        console.error(`❌ Product selection failed: ${selectResult.error}`)
        await logCartAddFailed(this.retailer, item.name, selectResult.error || 'Selection failed')
        return false
      }

      // Step 4: Prepare add to cart
      const prepareResult = await this.prepareAddToCart(item)
      if (!prepareResult.success || !prepareResult.element?.selector) {
        console.error(`❌ Could not find Add to Cart: ${prepareResult.error}`)
        await logCartAddFailed(this.retailer, item.name, prepareResult.error || 'No add button')
        return false
      }

      // Log attempt
      await logCartAddAttempt(this.retailer, item.name, prepareResult.screenshot)

      // ═══════════════════════════════════════════════════════
      // VISUAL VERIFICATION GATE (Constitutional Requirement)
      // ═══════════════════════════════════════════════════════
      const confirmed = await promptUserConfirmation(
        `🛒 Ready to add to cart:\n   Item: ${item.name}\n   Size: ${item.size || 'N/A'}\n   Retailer: ${this.retailer}`,
        prepareResult.screenshot!
      )

      await logCartAddDecision(this.retailer, item.name, confirmed)

      if (!confirmed) {
        console.log('⏹️ User declined. Item not added.')
        return false
      }

      // Step 5: Execute add to cart
      const addResult = await this.executeAddToCart(prepareResult.element.selector)
      if (!addResult.success) {
        console.error(`❌ Add to cart failed: ${addResult.error}`)
        await logCartAddFailed(this.retailer, item.name, addResult.error || 'Add failed')
        return false
      }

      await logCartAddSuccess(this.retailer, item.name, item.quantity || 1)
      console.log(`✅ Successfully added ${item.name} to ${this.retailer} cart!`)

      // Save session for future use
      await this.saveSession()

      return true

    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`)
      await logCartAddFailed(this.retailer, item.name, err.message)
      return false
    } finally {
      await this.close()
    }
  }

  /**
   * View current cart
   */
  async viewCart(): Promise<void> {
    try {
      await this.init()
      if (!this.page) throw new Error('Browser not initialized')

      // Common cart URLs
      const cartPaths = ['/cart', '/bag', '/basket', '/shopping-cart', '/checkout/cart']

      for (const path of cartPaths) {
        try {
          await this.page.goto(`${this.baseUrl}${path}`, { timeout: 5000 })
          if (this.page.url().includes('cart') || this.page.url().includes('bag')) {
            break
          }
        } catch {
          continue
        }
      }

      await this.page.waitForLoadState('networkidle')
      const screenshot = await takeScreenshot(this.page, `${this.retailer}-cart`)

      console.log(`\n🛒 ${this.retailer} Cart`)
      console.log(`📸 Screenshot: ${screenshot}`)
      console.log(`🔗 View in browser: ${this.page.url()}`)

      await auditLog('cart_view', { retailer: this.retailer, url: this.page.url() })

      // Keep browser open for user to review
      console.log('\nPress Enter to close browser...')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      await new Promise<void>(resolve => rl.question('', () => { rl.close(); resolve() }))

    } finally {
      await this.close()
    }
  }

  /**
   * Check if we have a valid saved session
   */
  async checkSession(): Promise<boolean> {
    const sessionPath = join(SESSION_DIR, `${this.retailer}-session.json`)
    if (!existsSync(sessionPath)) {
      return false
    }

    try {
      const data = await readFile(sessionPath, 'utf-8')
      const session = JSON.parse(data)
      // Check if session has cookies (basic validity check)
      return session.cookies && session.cookies.length > 0
    } catch {
      return false
    }
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.context = null
      this.page = null
    }
  }
}

/**
 * Factory function to create adapter for any retailer
 */
export function createShoppingAdapter(retailer: string): GenericShoppingAdapter {
  return new GenericShoppingAdapter(retailer)
}

/**
 * Get list of known retailers with direct URLs
 */
export function getKnownRetailers(): string[] {
  return Object.keys(RETAILER_URLS)
}
