#!/usr/bin/env bun
/**
 * Browser Session Server v2.0.0 - Debug-First Persistent Browser
 *
 * Persistent Playwright browser with ALWAYS-ON event capture.
 * Console logs, network requests, and errors captured from launch.
 *
 * Usage:
 *   # Started automatically by Browse.ts (not directly)
 *   BROWSER_PORT=9222 bun run BrowserSession.ts
 *
 * New API (v2.0.0):
 *   GET  /diagnostics  - Full diagnostic summary (errors, warnings, failed requests)
 *   GET  /console      - All console logs
 *   GET  /network      - All network activity
 *
 * Standard API:
 *   GET  /health       - Server health check
 *   GET  /session      - Current session info
 *   POST /navigate     - Navigate to URL (clears logs for fresh page)
 *   POST /click        - Click element
 *   POST /fill         - Fill input
 *   POST /screenshot   - Take screenshot
 *   GET  /text         - Get visible text
 *   POST /evaluate     - Run JavaScript
 *   POST /stop         - Stop server
 */

import { PlaywrightBrowser } from '../index.ts'
import { createStateManager } from '../../../../lib/core/StateManager.ts'
import { z } from 'zod'

const CONFIG = {
  port: parseInt(process.env.BROWSER_PORT || '9222'),
  cdpInternalPort: 9223, // Chrome's internal CDP debugging port for WebSocket proxying
  headless: process.env.BROWSER_HEADLESS === 'true',
  viewport: {
    width: parseInt(process.env.BROWSER_WIDTH || '1920'),
    height: parseInt(process.env.BROWSER_HEIGHT || '1080')
  },
  stateFile: '/tmp/browser-session.json',
  idleTimeout: 30 * 60 * 1000 // 30 minutes
}

const browser = new PlaywrightBrowser()
const sessionId = crypto.randomUUID().slice(0, 8)
const startedAt = new Date().toISOString()
let lastActivity = Date.now()
let pendingTracePath: string | null = null

// ============================================
// CDP WEBSOCKET PROXY
// ============================================

// Track upstream CDP WebSocket connections per client
// Keys are client WebSocket data objects (set via server.upgrade)
const cdpUpstreams = new Map<number, WebSocket>()
let cdpClientIdCounter = 0

/**
 * Get Chrome's CDP WebSocket debugger URL from its /json/version endpoint.
 * Chrome exposes this when launched with --remote-debugging-port.
 */
async function getCdpWebSocketUrl(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${CONFIG.cdpInternalPort}/json/version`, {
    signal: AbortSignal.timeout(2000),
  })
  const info = await res.json() as { webSocketDebuggerUrl: string }
  // Chrome sometimes returns ws://0.0.0.0:port/... — normalize to 127.0.0.1
  return info.webSocketDebuggerUrl.replace('0.0.0.0', '127.0.0.1')
}

// ============================================
// STATE MANAGEMENT (aligned with Browse.ts - uses StateManager)
// ============================================

const SessionStateSchema = z.object({
  pid: z.number(),
  port: z.number(),
  sessionId: z.string(),
  startedAt: z.string(),
  headless: z.boolean(),
  url: z.string(),
})

const stateManager = createStateManager({
  path: CONFIG.stateFile,
  schema: SessionStateSchema,
  defaults: {
    pid: 0,
    port: 0,
    sessionId: '',
    startedAt: '',
    headless: true,
    url: '',
  },
  backupOnWrite: true,
  lockTimeout: 5000,
})

async function saveState(): Promise<void> {
  try {
    await stateManager.save({
      pid: process.pid,
      port: CONFIG.port,
      sessionId,
      startedAt,
      headless: CONFIG.headless,
      url: browser.getUrl()
    })
  } catch (error) {
    console.error('Failed to save state:', error)
  }
}

async function cleanup(): Promise<void> {
  console.log('\nShutting down browser session...')
  try {
    await browser.close()
  } catch {}
  try {
    // Reset state to defaults to signal session is closed
    await stateManager.save({
      pid: 0,
      port: 0,
      sessionId: '',
      startedAt: '',
      headless: true,
      url: '',
    })
  } catch {}
  console.log('Session closed.')
  process.exit(0)
}

// ============================================
// IDLE TIMEOUT
// ============================================

function checkIdleTimeout(): void {
  const idle = Date.now() - lastActivity
  if (idle > CONFIG.idleTimeout) {
    console.log(`Idle timeout (${Math.round(idle / 60000)} minutes) - shutting down`)
    cleanup()
  }
}

// Check every minute
setInterval(checkIdleTimeout, 60 * 1000)

// ============================================
// RESPONSE HELPERS
// ============================================

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  })
}

function success(data?: any): Response {
  return json({ success: true, data })
}

function error(message: string, status = 500): Response {
  return json({ success: false, error: message }, status)
}

// ============================================
// LAUNCH BROWSER
// ============================================

console.log('Starting browser session...')
console.log(`  Port: ${CONFIG.port}`)
console.log(`  CDP internal port: ${CONFIG.cdpInternalPort}`)
console.log(`  Headless: ${CONFIG.headless}`)
console.log(`  Viewport: ${CONFIG.viewport.width}x${CONFIG.viewport.height}`)
console.log(`  Idle timeout: ${CONFIG.idleTimeout / 60000} minutes`)

await browser.launch({
  headless: CONFIG.headless,
  viewport: CONFIG.viewport,
  args: [`--remote-debugging-port=${CONFIG.cdpInternalPort}`],
})

// ============================================
// HTTP SERVER
// ============================================

const server = Bun.serve({
  port: CONFIG.port,

  async fetch(req, server) {
    const url = new URL(req.url)
    const method = req.method

    // Update activity timestamp on every request
    lastActivity = Date.now()

    // CDP WebSocket upgrade: proxy to Chrome's internal CDP port
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const clientId = ++cdpClientIdCounter
      const upgraded = server.upgrade(req, { data: { clientId } })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      })
    }

    try {
      // ========================================
      // DIAGNOSTIC ENDPOINTS (NEW in v2.0.0)
      // ========================================

      // Full diagnostics - errors, warnings, failed requests, stats
      if (url.pathname === '/diagnostics' && method === 'GET') {
        const allLogs = browser.getConsoleLogs()
        const errors = allLogs.filter(l => l.type === 'error')
        const warnings = allLogs.filter(l => l.type === 'warning')

        const networkLogs = browser.getNetworkLogs({ type: 'response' })
        const failedRequests = networkLogs
          .filter(l => l.status && l.status >= 400)
          .map(l => ({
            url: l.url,
            method: l.method,
            status: l.status!,
            statusText: l.statusText
          }))

        const stats = browser.getNetworkStats()

        return success({
          errors,
          warnings,
          failedRequests,
          stats,
          pageTitle: await browser.getTitle(),
          pageUrl: browser.getUrl()
        })
      }

      // Console logs
      if (url.pathname === '/console' && method === 'GET') {
        const type = url.searchParams.get('type') as any
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const logs = browser.getConsoleLogs({ type: type || undefined, limit })
        return success(logs)
      }

      // Network logs
      if (url.pathname === '/network' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const logs = browser.getNetworkLogs({ limit })
        return success(logs)
      }

      // ========================================
      // STANDARD ENDPOINTS
      // ========================================

      // Health check
      if (url.pathname === '/health' && method === 'GET') {
        // Check if CDP is available by pinging Chrome's debugging port
        let cdpAvailable = false
        try {
          const cdpRes = await fetch(`http://127.0.0.1:${CONFIG.cdpInternalPort}/json/version`, {
            signal: AbortSignal.timeout(500),
          })
          cdpAvailable = cdpRes.ok
        } catch { /* CDP not available */ }

        return success({
          status: 'ok',
          sessionId,
          uptime: Date.now() - new Date(startedAt).getTime(),
          cdpAvailable,
          cdpWebSocket: cdpAvailable ? `ws://localhost:${CONFIG.port}` : null,
        })
      }

      // Session info
      if (url.pathname === '/session' && method === 'GET') {
        return success({
          sessionId,
          startedAt,
          port: CONFIG.port,
          headless: CONFIG.headless,
          url: browser.getUrl(),
          title: await browser.getTitle(),
          idleTimeout: `${CONFIG.idleTimeout / 60000} minutes`,
          lastActivity: new Date(lastActivity).toISOString()
        })
      }

      // Navigate - CLEARS LOGS for fresh page diagnostics
      if (url.pathname === '/navigate' && method === 'POST') {
        const body = await req.json()
        if (!body.url) return error('url required', 400)

        // Clear logs before navigating for clean diagnostic slate
        browser.getConsoleLogs({ clear: true })
        browser.clearNetworkLogs()

        await browser.navigate(body.url, { waitUntil: body.waitUntil || 'networkidle' })
        await saveState()

        return success({
          url: browser.getUrl(),
          title: await browser.getTitle()
        })
      }

      // Click
      if (url.pathname === '/click' && method === 'POST') {
        const body = await req.json()
        if (!body.selector) return error('selector required', 400)
        await browser.click(body.selector, { timeout: body.timeout })
        return success({ clicked: body.selector })
      }

      // Fill
      if (url.pathname === '/fill' && method === 'POST') {
        const body = await req.json()
        if (!body.selector || body.value === undefined) return error('selector and value required', 400)
        await browser.fill(body.selector, body.value)
        return success({ filled: body.selector })
      }

      // Type (character by character)
      if (url.pathname === '/type' && method === 'POST') {
        const body = await req.json()
        if (!body.selector || !body.text) return error('selector and text required', 400)
        await browser.type(body.selector, body.text, body.delay)
        return success({ typed: body.selector })
      }

      // Screenshot
      if (url.pathname === '/screenshot' && method === 'POST') {
        const body = await req.json()
        const path = body.path || '/tmp/screenshot.png'
        await browser.screenshot({
          path,
          fullPage: body.fullPage || false,
          selector: body.selector
        })
        return success({ path })
      }

      // Get visible text
      if (url.pathname === '/text' && method === 'GET') {
        const selector = url.searchParams.get('selector') || undefined
        const text = await browser.getVisibleText(selector)
        return success({ text })
      }

      // Get HTML
      if (url.pathname === '/html' && method === 'GET') {
        const selector = url.searchParams.get('selector') || undefined
        const html = await browser.getVisibleHtml({ selector })
        return success({ html })
      }

      // Evaluate JavaScript
      if (url.pathname === '/evaluate' && method === 'POST') {
        const body = await req.json()
        if (!body.script) return error('script required', 400)
        const result = await browser.evaluate(body.script)
        return success({ result })
      }

      // Wait for selector
      if (url.pathname === '/wait' && method === 'POST') {
        const body = await req.json()
        if (!body.selector) return error('selector required', 400)
        await browser.waitForSelector(body.selector, {
          state: body.state,
          timeout: body.timeout
        })
        return success({ found: body.selector })
      }

      // Wait for text
      if (url.pathname === '/wait-text' && method === 'POST') {
        const body = await req.json()
        if (!body.text) return error('text required', 400)
        await browser.waitForText(body.text, {
          state: body.state,
          timeout: body.timeout
        })
        return success({ found: body.text })
      }

      // Hover
      if (url.pathname === '/hover' && method === 'POST') {
        const body = await req.json()
        if (!body.selector) return error('selector required', 400)
        await browser.hover(body.selector)
        return success({ hovered: body.selector })
      }

      // Press key
      if (url.pathname === '/press' && method === 'POST') {
        const body = await req.json()
        if (!body.key) return error('key required', 400)
        await browser.pressKey(body.key, body.selector)
        return success({ pressed: body.key })
      }

      // Select dropdown
      if (url.pathname === '/select' && method === 'POST') {
        const body = await req.json()
        if (!body.selector || !body.value) return error('selector and value required', 400)
        await browser.select(body.selector, body.value)
        return success({ selected: body.value })
      }

      // Tabs - list
      if (url.pathname === '/tabs' && method === 'GET') {
        const tabs = browser.getTabs()
        return success({ tabs })
      }

      // Tabs - new
      if (url.pathname === '/tabs' && method === 'POST') {
        const body = await req.json()
        await browser.newTab(body.url)
        return success({ created: true, url: body.url })
      }

      // Tabs - close
      if (url.pathname.startsWith('/tabs/') && method === 'DELETE') {
        const index = parseInt(url.pathname.split('/')[2])
        if (isNaN(index)) return error('invalid tab index', 400)
        await browser.switchTab(index)
        await browser.closeTab()
        return success({ closed: index })
      }

      // Tabs - switch
      if (url.pathname.startsWith('/tabs/') && method === 'POST') {
        const index = parseInt(url.pathname.split('/')[2])
        if (isNaN(index)) return error('invalid tab index', 400)
        await browser.switchTab(index)
        return success({ switched: index })
      }

      // Reload
      if (url.pathname === '/reload' && method === 'POST') {
        await browser.reload()
        return success({ reloaded: true })
      }

      // Go back
      if (url.pathname === '/back' && method === 'POST') {
        await browser.goBack()
        return success({ back: true })
      }

      // Go forward
      if (url.pathname === '/forward' && method === 'POST') {
        await browser.goForward()
        return success({ forward: true })
      }

      // Resize viewport
      if (url.pathname === '/resize' && method === 'POST') {
        const body = await req.json()
        if (!body.width || !body.height) return error('width and height required', 400)
        await browser.resize(body.width, body.height)
        return success({ width: body.width, height: body.height })
      }

      // Accessibility snapshot - save ARIA tree as YAML
      if (url.pathname === '/snapshot' && method === 'POST') {
        const body = await req.json().catch(() => ({}))
        const timestamp = Date.now()
        const outputPath = (body as Record<string, string>).path || `/tmp/snapshot-${timestamp}.yaml`

        // Get ARIA snapshot from Playwright
        const ariaTree = await browser.getAccessibilityTree()

        // Write YAML to disk
        const { writeFileSync, mkdirSync } = await import('fs')
        const { dirname } = await import('path')
        mkdirSync(dirname(outputPath), { recursive: true })
        writeFileSync(outputPath, ariaTree, 'utf-8')

        return success({ path: outputPath, size: ariaTree.length })
      }

      // State save - save cookies and storage
      if (url.pathname === '/state-save' && method === 'POST') {
        const body = await req.json()
        const name = (body as Record<string, string>).name
        if (!name) return error('name required', 400)

        const stateDir = `${process.env.HOME}/.claude/MEMORY/browser-states`
        const statePath = `${stateDir}/${name}.json`

        // Get cookies and localStorage via evaluate
        const cookies = await browser.evaluate(() => document.cookie)
        const localStorage = await browser.evaluate(() => {
          const items: Record<string, string> = {}
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i)
            if (key) items[key] = window.localStorage.getItem(key) || ''
          }
          return items
        })
        const sessionStorage = await browser.evaluate(() => {
          const items: Record<string, string> = {}
          for (let i = 0; i < window.sessionStorage.length; i++) {
            const key = window.sessionStorage.key(i)
            if (key) items[key] = window.sessionStorage.getItem(key) || ''
          }
          return items
        })
        const currentUrl = browser.getUrl()

        const stateData = {
          name,
          url: currentUrl,
          savedAt: new Date().toISOString(),
          cookies,
          localStorage,
          sessionStorage,
        }

        const { writeFileSync, mkdirSync } = await import('fs')
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(statePath, JSON.stringify(stateData, null, 2), 'utf-8')

        return success({ path: statePath, url: currentUrl })
      }

      // State load - restore cookies and storage
      if (url.pathname === '/state-load' && method === 'POST') {
        const body = await req.json()
        const name = (body as Record<string, string>).name
        if (!name) return error('name required', 400)

        const statePath = `${process.env.HOME}/.claude/MEMORY/browser-states/${name}.json`

        const { readFileSync, existsSync } = await import('fs')
        if (!existsSync(statePath)) {
          return error(`State file not found: ${statePath}`, 404)
        }

        const stateData = JSON.parse(readFileSync(statePath, 'utf-8')) as {
          name: string
          url: string
          savedAt: string
          cookies: string
          localStorage: Record<string, string>
          sessionStorage: Record<string, string>
        }

        // Navigate to the saved URL first (needed for storage context)
        if (stateData.url && stateData.url !== 'about:blank') {
          await browser.navigate(stateData.url, { waitUntil: 'domcontentloaded' })
        }

        // Restore cookies via evaluate
        if (stateData.cookies) {
          const cookieParts = stateData.cookies.split('; ')
          for (const cookie of cookieParts) {
            if (cookie.trim()) {
              await browser.evaluate(`document.cookie = ${JSON.stringify(cookie)}`)
            }
          }
        }

        // Restore localStorage
        if (stateData.localStorage) {
          for (const [key, value] of Object.entries(stateData.localStorage)) {
            await browser.evaluate(
              `window.localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
            )
          }
        }

        // Restore sessionStorage
        if (stateData.sessionStorage) {
          for (const [key, value] of Object.entries(stateData.sessionStorage)) {
            await browser.evaluate(
              `window.sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
            )
          }
        }

        // Reload to apply cookies
        await browser.reload()

        return success({
          loaded: name,
          url: stateData.url,
          savedAt: stateData.savedAt,
        })
      }

      // Trace start - begin recording
      if (url.pathname === '/trace-start' && method === 'POST') {
        const body = await req.json().catch(() => ({}))
        pendingTracePath = (body as Record<string, string>).path || `/tmp/trace-${Date.now()}.zip`
        await browser.startTrace()
        return success({ tracing: true, path: pendingTracePath })
      }

      // Trace stop - stop recording and save
      if (url.pathname === '/trace-stop' && method === 'POST') {
        const tracePath = pendingTracePath || `/tmp/trace-${Date.now()}.zip`
        const result = await browser.stopTrace(tracePath)
        pendingTracePath = null
        return success(result)
      }

      // Stop server
      if (url.pathname === '/stop' && method === 'POST') {
        setTimeout(() => cleanup(), 100)
        return success({ stopping: true })
      }

      return error('Not found', 404)

    } catch (err: any) {
      console.error('Request error:', err.message)
      return error(err.message)
    }
  },

  // ========================================
  // CDP WEBSOCKET PROXY
  // Enables Stagehand --session browse to share this browser via CDP
  // ========================================
  websocket: {
    async open(ws) {
      const clientId = (ws.data as { clientId: number }).clientId
      console.log(`CDP proxy: Client ${clientId} connected`)

      try {
        const cdpUrl = await getCdpWebSocketUrl()
        console.log(`CDP proxy: Connecting to Chrome at ${cdpUrl}`)

        const upstream = new WebSocket(cdpUrl)

        // Wait for upstream connection to open before setting up forwarding
        await new Promise<void>((resolve, reject) => {
          upstream.addEventListener('open', () => resolve(), { once: true })
          upstream.addEventListener('error', (e) => reject(e), { once: true })
          setTimeout(() => reject(new Error('CDP upstream connection timeout')), 5000)
        })

        cdpUpstreams.set(clientId, upstream)

        upstream.addEventListener('message', (event) => {
          try {
            ws.send(typeof event.data === 'string' ? event.data : event.data as ArrayBuffer)
          } catch {
            // Client may have disconnected
          }
        })

        upstream.addEventListener('close', () => {
          console.log(`CDP proxy: Chrome closed connection for client ${clientId}`)
          try { ws.close() } catch { /* already closed */ }
          cdpUpstreams.delete(clientId)
        })

        upstream.addEventListener('error', () => {
          console.error(`CDP proxy: Upstream error for client ${clientId}`)
          try { ws.close() } catch { /* already closed */ }
          cdpUpstreams.delete(clientId)
        })

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`CDP proxy: Failed to connect to Chrome CDP — ${message}`)
        console.error(`CDP proxy: Ensure Chrome was launched with --remote-debugging-port=${CONFIG.cdpInternalPort}`)
        ws.close()
      }
    },

    message(ws, message) {
      const clientId = (ws.data as { clientId: number }).clientId
      const upstream = cdpUpstreams.get(clientId)
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(typeof message === 'string' ? message : message)
      }
    },

    close(ws) {
      const clientId = (ws.data as { clientId: number }).clientId
      console.log(`CDP proxy: Client ${clientId} disconnected`)
      const upstream = cdpUpstreams.get(clientId)
      if (upstream) {
        upstream.close()
        cdpUpstreams.delete(clientId)
      }
    },
  },
})

await saveState()
console.log(`\nBrowser session started!`)
console.log(`  Session ID: ${sessionId}`)
console.log(`  URL: http://localhost:${CONFIG.port}`)
console.log(`  CDP WebSocket: ws://localhost:${CONFIG.port} (proxied to Chrome port ${CONFIG.cdpInternalPort})`)
console.log(`  Diagnostics: http://localhost:${CONFIG.port}/diagnostics`)
console.log(`\nStagehand can connect via: bun run Stagehand.ts --session browse <command>`)
console.log(`Session will auto-close after ${CONFIG.idleTimeout / 60000} minutes of inactivity.`)
console.log(`Press Ctrl+C to stop manually.`)

// Cleanup handlers
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  cleanup()
})
