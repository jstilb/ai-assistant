#!/usr/bin/env bun
/**
 * Instacart CLI Tool v2.0.0
 *
 * Browser automation for adding items to Instacart cart.
 * Uses saved session for consistency and reliability.
 *
 * Usage:
 *   bun run Instacart.ts login                     # Login and save session
 *   bun run Instacart.ts add "bananas"             # Add item to cart
 *   bun run Instacart.ts add "3x milk" --store Safeway  # Add with quantity + store
 *   bun run Instacart.ts cart                      # View cart
 *   bun run Instacart.ts status                    # Check session
 *   bun run Instacart.ts logout                    # Clear session
 *   bun run Instacart.ts check-selectors           # Validate selectors
 */

// 1. External dependencies
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// 2. Kaya infrastructure imports
import { notifySync } from '../../CORE/Tools/NotificationService.ts';

// 3. Local imports
import { SelectorEngine, type SelectorConfig } from './selector-engine';
import { applyStealthPatches, getRandomUA, getRandomViewport, humanDelay } from './stealth';
import { parseItem, sanitizeItemName } from './item-utils';
import { matchStore } from './store-matcher';

// ============================================
// CONSTANTS & CONFIG
// ============================================

const SESSION_FILE = join(homedir(), '.instacart-session.json');
const INSTACART_URL = 'https://www.instacart.com';
const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), '.claude');
const LOG_DIR = process.env.INSTACART_LOG_DIR || join(KAYA_HOME, 'MEMORY', 'LOGS', 'instacart');
const CONFIG_DIR = join(import.meta.dir, '..', 'config');
const MAX_ITEMS = 50;

// Load selector config
function loadSelectorConfig(): Record<string, SelectorConfig> {
  const configPath = join(CONFIG_DIR, 'selectors.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Strip description field, keep only primary + fallbacks
    const config: Record<string, SelectorConfig> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as { primary: string; fallbacks: string[]; description?: string };
      config[key] = { primary: entry.primary, fallbacks: entry.fallbacks };
    }
    return config;
  } catch (error) {
    log('ERROR', 'Config', `Failed to load selectors.json: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error('Failed to load selector configuration. Ensure config/selectors.json exists.');
  }
}

// Load known stores list
function loadKnownStores(): string[] {
  const storePath = join(CONFIG_DIR, 'known-stores.json');
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8'));
  } catch (error) {
    log('WARN', 'Config', `Failed to load known-stores.json: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

// ============================================
// STRUCTURED LOGGING
// ============================================

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', component: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${component}: ${message}`;
  if (data) {
    console.log(entry, JSON.stringify(data));
  } else {
    console.log(entry);
  }
}

// ============================================
// EXECUTION REPORT
// ============================================

interface ExecutionReport {
  status: 'success' | 'partial' | 'failure' | 'captcha_abort';
  itemsAdded: number;
  itemsFailed: Array<{ name: string; reason: string }>;
  store: string | null;
  timestamp: string;
  durationMs: number;
  userAgent: string;
}

function writeExecutionReport(report: ExecutionReport): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const filename = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    const filepath = join(LOG_DIR, filename);
    const content = JSON.stringify(report, null, 2);
    appendFileSync(filepath, content);
    log('INFO', 'Report', `Execution report written to ${filepath}`);
  } catch (error) {
    log('ERROR', 'Report', `Failed to write execution report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================
// METRICS
// ============================================

interface MetricsEntry {
  timestamp: string;
  successRate: number;
  selectorHitRates: Record<string, { primary: number; fallback: number; failed: number }>;
  perItemDurations: number[];
  botDetectionEvents: number;
}

function appendMetrics(entry: MetricsEntry): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const metricsPath = join(LOG_DIR, 'metrics.jsonl');
    appendFileSync(metricsPath, JSON.stringify(entry) + '\n');
    log('INFO', 'Metrics', 'Metrics appended to metrics.jsonl');
  } catch (error) {
    log('ERROR', 'Metrics', `Failed to append metrics: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkDegradation(): void {
  try {
    const metricsPath = join(LOG_DIR, 'metrics.jsonl');
    if (!existsSync(metricsPath)) return;

    const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n');
    const recent = lines.slice(-5);
    if (recent.length < 5) return;

    const rates = recent.map(line => {
      const entry = JSON.parse(line) as MetricsEntry;
      return entry.successRate;
    });
    const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;

    if (avgRate < 0.7) {
      log('WARN', 'Metrics', `Degradation detected: ${(avgRate * 100).toFixed(1)}% success rate over last 5 runs`);
      notifySync('Instacart skill maintenance needed: low success rate');
    }
  } catch (error) {
    log('ERROR', 'Metrics', `Failed to check degradation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================
// PRE-FLIGHT CHECKS
// ============================================

async function ensureDependencies(): Promise<void> {
  const nodeModulesPath = join(import.meta.dir, '..', 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    log('INFO', 'PreFlight', 'node_modules not found. Running bun install...');
    const proc = Bun.spawn(['bun', 'install'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`bun install failed with exit code ${exitCode}`);
    }
    log('INFO', 'PreFlight', 'Dependencies installed successfully');
  }
}

// ============================================
// CAPTCHA DETECTION
// ============================================

async function detectCaptcha(page: Page, selectors: Record<string, SelectorConfig>): Promise<boolean> {
  const captchaConfig = selectors.captchaChallenge;
  if (!captchaConfig) return false;

  const allSelectors = [captchaConfig.primary, ...captchaConfig.fallbacks];
  for (const selector of allSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        log('WARN', 'CAPTCHA', `CAPTCHA/challenge detected via selector: ${selector}`);
        return true;
      }
    } catch (error) {
      log('DEBUG', 'CAPTCHA', `Error checking selector ${selector}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function loadSession(): Promise<Record<string, unknown> | null> {
  try {
    if (existsSync(SESSION_FILE)) {
      const content = await readFile(SESSION_FILE, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    }
  } catch (error) {
    log('WARN', 'Session', `Failed to load session: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

async function saveSession(context: BrowserContext): Promise<void> {
  const storage = await context.storageState();
  await writeFile(SESSION_FILE, JSON.stringify(storage, null, 2));
  log('INFO', 'Session', `Session saved to ${SESSION_FILE}`);
}

async function clearSession(): Promise<void> {
  try {
    if (existsSync(SESSION_FILE)) {
      await unlink(SESSION_FILE);
      log('INFO', 'Session', 'Session cleared');
    } else {
      log('INFO', 'Session', 'No session to clear');
    }
  } catch (error) {
    log('ERROR', 'Session', `Failed to clear session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================
// BROWSER HELPERS
// ============================================

async function launchBrowser(headless: boolean = true): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const session = await loadSession();
  const userAgent = getRandomUA();
  const viewport = getRandomViewport();

  log('INFO', 'Browser', `Launching with UA: ${userAgent.substring(0, 60)}...`);
  log('INFO', 'Browser', `Viewport: ${viewport.width}x${viewport.height}`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const contextOptions: Record<string, unknown> = {
    viewport,
    userAgent,
  };

  if (session) {
    contextOptions.storageState = session;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Apply stealth patches
  await applyStealthPatches(page);

  return { browser, context, page };
}

async function isLoggedIn(page: Page, selectors: Record<string, SelectorConfig>): Promise<boolean> {
  try {
    const accountConfig = selectors.accountButton;
    const allAccountSelectors = [accountConfig.primary, ...accountConfig.fallbacks];
    for (const selector of allAccountSelectors) {
      const el = await page.$(selector);
      if (el) return true;
    }

    if (page.url().includes('/login') || page.url().includes('/signup')) {
      return false;
    }

    const signInConfig = selectors.signInButton;
    const allSignInSelectors = [signInConfig.primary, ...signInConfig.fallbacks];
    for (const selector of allSignInSelectors) {
      const el = await page.$(selector);
      if (el) return false;
    }

    return true;
  } catch (error) {
    log('WARN', 'Auth', `Login check failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ============================================
// COMMANDS
// ============================================

async function login(): Promise<void> {
  notifySync('Opening Instacart for login');
  log('INFO', 'Login', 'Opening Instacart for manual login...');

  const { browser, context, page } = await launchBrowser(false);
  const selectors = loadSelectorConfig();

  try {
    await page.goto(INSTACART_URL);

    log('INFO', 'Login', 'Waiting for login... (close browser when done)');

    let loggedIn = false;
    while (!loggedIn) {
      await page.waitForTimeout(2000);

      try {
        loggedIn = await isLoggedIn(page, selectors);
        if (loggedIn) {
          log('INFO', 'Login', 'Login detected!');
          await page.waitForTimeout(2000);
          await saveSession(context);
          break;
        }
      } catch (error) {
        // Browser was closed by user
        log('INFO', 'Login', `Browser closed during login: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }

    log('INFO', 'Login', 'You can continue browsing or close the browser when ready.');

    await new Promise<void>((resolve) => {
      browser.on('disconnected', () => resolve());
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Target closed') || msg.includes('Browser closed')) {
      try {
        await saveSession(context);
      } catch (saveError) {
        log('WARN', 'Login', `Could not save session on close: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
      }
    } else {
      log('ERROR', 'Login', `Login error: ${msg}`);
    }
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      log('DEBUG', 'Login', `Browser already closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
    notifySync('Instacart login session complete');
  }
}

async function addItems(
  rawItems: string[],
  globalQuantity: number = 1,
  headless: boolean = true,
  storeName: string | null = null,
): Promise<void> {
  const startTime = Date.now();
  const selectors = loadSelectorConfig();
  const selectorEngine = new SelectorEngine();
  const session = await loadSession();
  const userAgent = getRandomUA();

  // Track metrics
  const selectorHitRates: Record<string, { primary: number; fallback: number; failed: number }> = {};
  const perItemDurations: number[] = [];
  let botDetectionEvents = 0;
  let itemsAdded = 0;
  const itemsFailed: Array<{ name: string; reason: string }> = [];

  if (!session) {
    log('ERROR', 'Add', 'No session found. Run "login" first.');
    notifySync('Shopping failed. No session found.');
    process.exit(1);
  }

  // Parse items (handles inline quantities like "3x Eggs")
  const parsedItems = rawItems.map(raw => {
    const parsed = parseItem(raw);
    // If globalQuantity was explicitly set and item has no inline quantity, use global
    if (parsed.quantity === 1 && globalQuantity > 1) {
      parsed.quantity = globalQuantity;
    }
    parsed.name = sanitizeItemName(parsed.name);
    return parsed;
  });

  const totalItems = parsedItems.length;
  const storeLabel = storeName || 'default store';

  notifySync(`Adding ${totalItems} item(s) to Instacart cart`);
  log('INFO', 'Add', `Adding ${totalItems} item(s) to cart...`, {
    items: parsedItems.map(i => `${i.quantity}x ${i.name}`),
    store: storeName,
  });

  const { browser, context, page } = await launchBrowser(headless);

  try {
    await page.goto(INSTACART_URL);
    await page.waitForLoadState('networkidle');

    // CAPTCHA check
    if (await detectCaptcha(page, selectors)) {
      botDetectionEvents++;
      log('WARN', 'Add', 'CAPTCHA detected on initial load. Aborting.');
      notifySync('Shopping interrupted. Instacart requests verification.');
      writeExecutionReport({
        status: 'captcha_abort',
        itemsAdded: 0,
        itemsFailed: parsedItems.map(i => ({ name: i.name, reason: 'CAPTCHA detected' })),
        store: storeName,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        userAgent,
      });
      return; // Leave browser open for manual intervention
    }

    // Verify logged in
    if (!await isLoggedIn(page, selectors)) {
      log('ERROR', 'Add', 'Session expired. Run "login" again.');
      notifySync('Shopping failed. Session expired.');
      await browser.close();
      process.exit(1);
    }

    // Store selection (M2 feature)
    if (storeName) {
      const stores = loadKnownStores();
      if (stores.length > 0) {
        const match = matchStore(storeName, stores);
        if (match.matched) {
          log('INFO', 'Store', `Matched store: ${match.store}`);
          // Navigate to store selection
          const storeSelectorResult = await selectorEngine.resolve(page, selectors.storeSelector);
          if (storeSelectorResult.success) {
            const storeEl = storeSelectorResult.data.element as { click(): Promise<void> };
            await storeEl.click();
            await humanDelay(page);

            // Search for store
            const storeSearchResult = await selectorEngine.resolve(page, selectors.storeSearchInput);
            if (storeSearchResult.success) {
              const searchEl = storeSearchResult.data.element as { fill(text: string): Promise<void>; click(): Promise<void> };
              await searchEl.click();
              await searchEl.fill(match.store);
              await humanDelay(page);

              // Click store option
              const storeOptionResult = await selectorEngine.resolve(page, selectors.storeOption);
              if (storeOptionResult.success) {
                const optionEl = storeOptionResult.data.element as { click(): Promise<void> };
                await optionEl.click();
                await humanDelay(page);
                log('INFO', 'Store', `Selected store: ${match.store}`);
              } else {
                log('WARN', 'Store', 'Could not find store option after search');
              }
            }
          } else {
            log('WARN', 'Store', 'Could not find store selector UI element');
          }
        } else {
          const suggestions = match.suggestions.join(', ');
          log('ERROR', 'Store', `Store "${storeName}" not found. Suggestions: ${suggestions}`);
          notifySync(`Shopping failed. Unknown store: ${storeName}`);
          writeExecutionReport({
            status: 'failure',
            itemsAdded: 0,
            itemsFailed: parsedItems.map(i => ({ name: i.name, reason: `Unknown store: ${storeName}` })),
            store: storeName,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            userAgent,
          });
          await browser.close();
          return;
        }
      } else {
        log('WARN', 'Store', 'No known-stores.json loaded. Ignoring --store flag.');
      }
    }

    // Add each item
    for (const item of parsedItems) {
      const itemStartTime = Date.now();
      log('INFO', 'Add', `Searching for: ${item.name} (qty: ${item.quantity})`);

      // CAPTCHA check before each item
      if (await detectCaptcha(page, selectors)) {
        botDetectionEvents++;
        log('WARN', 'Add', 'CAPTCHA detected during item loop. Aborting remaining items.');
        // Record remaining items as failed
        const remaining = parsedItems.slice(parsedItems.indexOf(item));
        for (const r of remaining) {
          itemsFailed.push({ name: r.name, reason: 'CAPTCHA detected' });
        }
        notifySync('Shopping interrupted. Instacart requests verification.');
        break;
      }

      // Find search input using selector engine
      const searchResult = await selectorEngine.resolve(page, selectors.searchInput);
      trackSelectorResult('searchInput', searchResult, selectorHitRates);

      if (!searchResult.success) {
        log('WARN', 'Add', `Could not find search input for: ${item.name}`);
        itemsFailed.push({ name: item.name, reason: 'Search input not found' });
        perItemDurations.push(Date.now() - itemStartTime);
        continue;
      }

      const searchInput = searchResult.data.element as { click(): Promise<void>; fill(text: string): Promise<void> };
      await searchInput.click();
      await searchInput.fill('');
      await searchInput.fill(item.name);
      await page.keyboard.press('Enter');

      await page.waitForLoadState('networkidle');
      await humanDelay(page);

      // Check for CAPTCHA after search
      if (await detectCaptcha(page, selectors)) {
        botDetectionEvents++;
        itemsFailed.push({ name: item.name, reason: 'CAPTCHA after search' });
        break;
      }

      // Try to find and click add-to-cart button
      const addResult = await selectorEngine.resolve(page, selectors.addToCartButton);
      trackSelectorResult('addToCartButton', addResult, selectorHitRates);

      if (addResult.success) {
        const addButton = addResult.data.element as { click(): Promise<void> };
        for (let i = 0; i < item.quantity; i++) {
          await addButton.click();
          await page.waitForTimeout(500);
        }
        log('INFO', 'Add', `Added: ${item.name} (qty: ${item.quantity})`);
        itemsAdded++;
      } else {
        // Try clicking on first product then adding from modal
        const productResult = await selectorEngine.resolve(page, selectors.productCard);
        trackSelectorResult('productCard', productResult, selectorHitRates);

        if (productResult.success) {
          const productEl = productResult.data.element as { click(): Promise<void> };
          await productEl.click();
          await humanDelay(page);

          const modalResult = await selectorEngine.resolve(page, selectors.modalAddButton);
          trackSelectorResult('modalAddButton', modalResult, selectorHitRates);

          if (modalResult.success) {
            const modalBtn = modalResult.data.element as { click(): Promise<void> };
            for (let i = 0; i < item.quantity; i++) {
              await modalBtn.click();
              await page.waitForTimeout(500);
            }
            log('INFO', 'Add', `Added: ${item.name} (qty: ${item.quantity}) via product modal`);
            itemsAdded++;

            // Close modal if present
            const closeResult = await selectorEngine.resolve(page, selectors.closeModal);
            if (closeResult.success) {
              const closeBtn = closeResult.data.element as { click(): Promise<void> };
              await closeBtn.click();
            }
          } else {
            log('WARN', 'Add', `Could not find add button for: ${item.name}`);
            itemsFailed.push({ name: item.name, reason: 'Add button not found in modal' });
          }
        } else {
          log('WARN', 'Add', `No results found for: ${item.name}`);
          itemsFailed.push({ name: item.name, reason: 'No search results' });
        }
      }

      perItemDurations.push(Date.now() - itemStartTime);
      await humanDelay(page);
    }

    // Save updated session
    await saveSession(context);

    // Determine status
    const status: ExecutionReport['status'] =
      itemsAdded === totalItems ? 'success' :
      itemsAdded > 0 ? 'partial' :
      'failure';

    // Write execution report
    const report: ExecutionReport = {
      status,
      itemsAdded,
      itemsFailed,
      store: storeName,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      userAgent,
    };
    writeExecutionReport(report);

    // Write metrics
    const successRate = totalItems > 0 ? itemsAdded / totalItems : 0;
    appendMetrics({
      timestamp: new Date().toISOString(),
      successRate,
      selectorHitRates,
      perItemDurations,
      botDetectionEvents,
    });

    // Send appropriate notification
    const notifyMessage = buildNotifyMessage(status, itemsAdded, totalItems, itemsFailed.length, storeLabel);
    notifySync(notifyMessage);
    log('INFO', 'Add', notifyMessage);

    // Check for degradation
    checkDegradation();

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('ERROR', 'Add', `Unexpected error: ${msg}`);
    notifySync(`Shopping failed. ${msg.substring(0, 60)}`);
    writeExecutionReport({
      status: 'failure',
      itemsAdded,
      itemsFailed: [...itemsFailed, ...parsedItems.filter(i => !itemsFailed.find(f => f.name === i.name) && itemsAdded === 0).map(i => ({ name: i.name, reason: msg }))],
      store: storeName,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      userAgent,
    });
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      log('DEBUG', 'Add', `Browser close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
  }
}

function trackSelectorResult(
  name: string,
  result: { success: boolean; data?: { fallbackLevel: number } },
  rates: Record<string, { primary: number; fallback: number; failed: number }>,
): void {
  if (!rates[name]) {
    rates[name] = { primary: 0, fallback: 0, failed: 0 };
  }
  if (result.success && result.data) {
    if (result.data.fallbackLevel === 0) {
      rates[name].primary++;
    } else {
      rates[name].fallback++;
    }
  } else {
    rates[name].failed++;
  }
}

function buildNotifyMessage(
  status: ExecutionReport['status'],
  added: number,
  total: number,
  failed: number,
  store: string,
): string {
  // All messages must be <=100 characters
  switch (status) {
    case 'success':
      return `Shopping complete. Added ${added} of ${total} items to ${store} cart.`.substring(0, 100);
    case 'partial':
      return `Partial success. Added ${added} of ${total} items. ${failed} unavailable.`.substring(0, 100);
    case 'failure':
      return `Shopping failed. Could not add items to ${store} cart.`.substring(0, 100);
    case 'captcha_abort':
      return 'Shopping interrupted. Instacart requests verification.';
    default:
      return 'Shopping complete.';
  }
}

async function viewCart(headless: boolean = true): Promise<void> {
  const session = await loadSession();
  const selectors = loadSelectorConfig();

  if (!session) {
    log('ERROR', 'Cart', 'No session found. Run "login" first.');
    notifySync('Cart view failed. No session found.');
    process.exit(1);
  }

  log('INFO', 'Cart', 'Fetching cart contents...');

  const { browser, context, page } = await launchBrowser(headless);

  try {
    await page.goto(`${INSTACART_URL}/store/checkout_v3/cart`);
    await page.waitForLoadState('networkidle');
    await humanDelay(page);

    const screenshotPath = `/tmp/instacart-cart-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log('INFO', 'Cart', `Cart screenshot: ${screenshotPath}`);

    // Try to extract cart items using selector config
    const cartItemSelector = [selectors.cartItem.primary, ...selectors.cartItem.fallbacks].join(', ');
    const nameSelector = [selectors.itemName.primary, ...selectors.itemName.fallbacks].join(', ');
    const priceSelector = [selectors.itemPrice.primary, ...selectors.itemPrice.fallbacks].join(', ');
    const qtySelector = [selectors.itemQuantity.primary, ...selectors.itemQuantity.fallbacks].join(', ');

    const cartItems = await page.$$eval(cartItemSelector, (elements, selectors) => {
      return elements.map(el => {
        const name = el.querySelector(selectors.name)?.textContent?.trim();
        const price = el.querySelector(selectors.price)?.textContent?.trim();
        const qty = el.querySelector(selectors.qty)?.getAttribute('value') || '1';
        return { name, price, qty };
      }).filter(item => item.name);
    }, { name: nameSelector, price: priceSelector, qty: qtySelector });

    if (cartItems.length > 0) {
      log('INFO', 'Cart', `Found ${cartItems.length} items in cart:`);
      for (const item of cartItems) {
        log('INFO', 'Cart', `  ${item.name} (qty: ${item.qty}) - ${item.price || 'price N/A'}`);
      }
    } else {
      log('INFO', 'Cart', 'Cart appears empty or could not read items. Check screenshot.');
    }

    notifySync(`Cart has ${cartItems.length} items`);
  } catch (error) {
    log('ERROR', 'Cart', `Cart view error: ${error instanceof Error ? error.message : String(error)}`);
    notifySync('Cart view failed.');
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      log('DEBUG', 'Cart', `Browser close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
  }
}

async function checkStatus(): Promise<void> {
  const session = await loadSession();
  const selectors = loadSelectorConfig();

  if (!session) {
    log('INFO', 'Status', 'No session saved. Run "login" to create one.');
    notifySync('No Instacart session found.');
    return;
  }

  log('INFO', 'Status', 'Checking session validity...');

  const { browser, page } = await launchBrowser(true);

  try {
    await page.goto(INSTACART_URL);
    await page.waitForLoadState('networkidle');

    const loggedIn = await isLoggedIn(page, selectors);

    if (loggedIn) {
      log('INFO', 'Status', `Session is valid. File: ${SESSION_FILE}`);
      notifySync('Instacart session is valid.');
    } else {
      log('INFO', 'Status', 'Session expired. Run "login" to refresh.');
      notifySync('Instacart session expired.');
    }
  } catch (error) {
    log('ERROR', 'Status', `Session check error: ${error instanceof Error ? error.message : String(error)}`);
    notifySync('Session check failed.');
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      log('DEBUG', 'Status', `Browser close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
  }
}

async function checkSelectors(): Promise<void> {
  log('INFO', 'SelectorCheck', 'Validating selectors against live Instacart page...');

  const session = await loadSession();
  if (!session) {
    log('ERROR', 'SelectorCheck', 'No session found. Run "login" first.');
    process.exit(1);
  }

  const selectors = loadSelectorConfig();
  const { browser, page } = await launchBrowser(true);
  let anyFailed = false;

  try {
    await page.goto(INSTACART_URL);
    await page.waitForLoadState('networkidle');
    await humanDelay(page);

    for (const [name, config] of Object.entries(selectors)) {
      // Skip captcha selector (we don't want to find it)
      if (name === 'captchaChallenge') continue;

      let primaryWorked = false;
      let fallbackUsed: string | null = null;

      const primaryEl = await page.$(config.primary);
      if (primaryEl) {
        primaryWorked = true;
        log('INFO', 'SelectorCheck', `  ${name}: OK (primary)`);
      } else {
        for (const fb of config.fallbacks) {
          const fbEl = await page.$(fb);
          if (fbEl) {
            fallbackUsed = fb;
            log('WARN', 'SelectorCheck', `  ${name}: OK (fallback: ${fb})`);
            break;
          }
        }

        if (!fallbackUsed) {
          log('ERROR', 'SelectorCheck', `  ${name}: BROKEN - no selector works. Primary: ${config.primary}`);
          anyFailed = true;
        }
      }
    }

    if (anyFailed) {
      log('ERROR', 'SelectorCheck', 'Some selectors are broken. Update config/selectors.json.');
      notifySync('Instacart selectors need updating.');
      process.exit(1);
    } else {
      log('INFO', 'SelectorCheck', 'All selectors validated successfully.');
      notifySync('Instacart selectors validated OK.');
    }
  } catch (error) {
    log('ERROR', 'SelectorCheck', `Selector check error: ${error instanceof Error ? error.message : String(error)}`);
    notifySync('Selector check failed.');
    process.exit(1);
  } finally {
    try {
      await browser.close();
    } catch (closeError) {
      log('DEBUG', 'SelectorCheck', `Browser close: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
  }
}

// ============================================
// MAIN
// ============================================

function showHelp(): void {
  console.log(`
Instacart CLI v2.0.0 - Browser Automation for Grocery Shopping

Usage:
  bun run Instacart.ts login                        Login and save session
  bun run Instacart.ts add <items...>               Add items to cart
  bun run Instacart.ts add "3x milk" --store Safeway Add with inline quantity + store
  bun run Instacart.ts cart                         View current cart
  bun run Instacart.ts status                       Check session validity
  bun run Instacart.ts logout                       Clear saved session
  bun run Instacart.ts check-selectors              Validate CSS selectors

Options:
  --qty <n>       Global quantity (default: 1; overridden by inline "3x")
  --store <name>  Preferred store (fuzzy matched)
  --headless      Run without visible browser
  --visible       Run with visible browser

Quantity Formats:
  "3x Eggs"       Three eggs (prefix format)
  "Eggs x3"       Three eggs (suffix format)
  "3 Eggs"        Three eggs (number-space format)
  "Eggs"          One egg (default)

Examples:
  bun run Instacart.ts add "organic bananas" "3x almond milk" "eggs"
  bun run Instacart.ts add "avocados" --qty 4 --store Safeway
  bun run Instacart.ts cart --visible
  bun run Instacart.ts check-selectors
`);
}

async function main(): Promise<void> {
  // Pre-flight dependency check
  await ensureDependencies();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  // Parse flags
  let quantity = 1;
  let headless = true;
  let store: string | null = null;
  const items: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--qty' && args[i + 1]) {
      quantity = parseInt(args[i + 1], 10) || 1;
      i++;
    } else if (args[i] === '--store' && args[i + 1]) {
      store = args[i + 1];
      i++;
    } else if (args[i] === '--headless') {
      headless = true;
    } else if (args[i] === '--visible') {
      headless = false;
    } else if (!args[i].startsWith('--')) {
      items.push(args[i]);
    }
  }

  try {
    switch (command) {
      case 'login':
        await login();
        break;

      case 'add':
        if (items.length === 0) {
          log('ERROR', 'Main', 'Please specify items to add');
          console.log('Example: bun run Instacart.ts add "bananas" "3x milk"');
          process.exit(1);
        }
        if (items.length > MAX_ITEMS) {
          log('ERROR', 'Main', `Too many items (${items.length}). Maximum is ${MAX_ITEMS}.`);
          process.exit(1);
        }
        await addItems(items, quantity, headless, store);
        break;

      case 'cart':
        await viewCart(headless);
        break;

      case 'status':
        await checkStatus();
        break;

      case 'logout':
        await clearSession();
        notifySync('Instacart session cleared.');
        break;

      case 'check-selectors':
        await checkSelectors();
        break;

      default:
        log('ERROR', 'Main', `Unknown command: ${command}`);
        console.log('Run with --help for usage');
        process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('ERROR', 'Main', `Fatal error: ${msg}`);
    notifySync(`Instacart error: ${msg.substring(0, 80)}`);
    process.exit(1);
  }
}

main();
