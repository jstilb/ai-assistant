#!/usr/bin/env bun
/**
 * Stagehand CLI Tool v1.0.0 - AI-Driven Browser Automation
 *
 * Wraps Stagehand v3 SDK as a CLI tool for AI-driven browser interaction.
 * Complements Browse.ts (deterministic) with AI-powered dynamic interaction.
 *
 * Usage:
 *   bun run Stagehand.ts act "<instruction>"
 *   bun run Stagehand.ts extract "<instruction>" [--schema '{"key":"string"}']
 *   bun run Stagehand.ts observe "<instruction>"
 *   bun run Stagehand.ts agent "<task>"
 *   bun run Stagehand.ts cache list|clear|stats
 *
 * Flags:
 *   --url <url>           Navigate to URL before action
 *   --session browse      Connect to existing Browse.ts session via CDP (port 9222)
 *
 * Examples:
 *   bun run Stagehand.ts act "Click the login button"
 *   bun run Stagehand.ts extract "Get all prices" --schema '{"prices":"string[]"}'
 *   bun run Stagehand.ts observe "What interactive elements are on this page?"
 *   bun run Stagehand.ts agent "Log in with test@example.com / pass123"
 *   bun run Stagehand.ts --url https://example.com act "Click More information"
 *   bun run Stagehand.ts --session browse act "Click submit"
 *   bun run Stagehand.ts cache stats
 */

import { parseArgs } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { Stagehand, type V3Options, type ModelConfiguration } from '@browserbasehq/stagehand'

// ============================================
// CONSTANTS
// ============================================

const CDP_PORT = 9222
const CACHE_DIR = join(homedir(), '.claude', 'MEMORY', 'stagehand-cache')
const CACHE_STATS_FILE = join(CACHE_DIR, 'stats.json')
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json')
const SECRETS_FILE = join(homedir(), '.claude', 'secrets.json')

// ============================================
// SETTINGS & SECRETS
// ============================================

interface StagehandSettings {
  provider: string
  model: string
  fallbackProvider: string
  fallbackModel: string
}

interface Settings {
  stagehand?: StagehandSettings
  [key: string]: unknown
}

interface Secrets {
  GEMINI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  [key: string]: unknown
}

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, 'utf-8')
      return JSON.parse(raw) as Settings
    }
  } catch {
    // Silent fail - use defaults
  }
  return {}
}

function loadSecrets(): Secrets {
  try {
    if (existsSync(SECRETS_FILE)) {
      const raw = readFileSync(SECRETS_FILE, 'utf-8')
      return JSON.parse(raw) as Secrets
    }
  } catch {
    // Silent fail - use env vars
  }
  return {}
}

function getStagehandConfig(): { model: ModelConfiguration; apiKey: string } {
  const settings = loadSettings()
  const secrets = loadSecrets()

  const stagehandSettings = settings.stagehand ?? {
    provider: 'google',
    model: 'gemini-2.0-flash',
    fallbackProvider: 'anthropic',
    fallbackModel: 'claude-3-7-sonnet-latest',
  }

  // Normalize provider name: "gemini" -> "google" for Stagehand's model naming
  const providerPrefix = stagehandSettings.provider === 'gemini' ? 'google' : stagehandSettings.provider
  const modelName = stagehandSettings.model as ModelConfiguration

  // Get API key based on provider
  const apiKey =
    stagehandSettings.provider === 'gemini' || stagehandSettings.provider === 'google'
      ? (secrets.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '')
      : (secrets.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '')

  // Set env var so Stagehand can pick it up via providerEnvVarMap
  if (stagehandSettings.provider === 'gemini' || stagehandSettings.provider === 'google') {
    process.env.GOOGLE_API_KEY = apiKey
    process.env.GEMINI_API_KEY = apiKey
  } else if (stagehandSettings.provider === 'anthropic') {
    process.env.ANTHROPIC_API_KEY = apiKey
  }

  return { model: modelName, apiKey }
}

// ============================================
// CACHE MANAGEMENT
// ============================================

interface CacheStats {
  hits: number
  misses: number
  entries: number
  createdAt: string
  updatedAt: string
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true })
}

function loadCacheStats(): CacheStats {
  try {
    if (existsSync(CACHE_STATS_FILE)) {
      const raw = readFileSync(CACHE_STATS_FILE, 'utf-8')
      return JSON.parse(raw) as CacheStats
    }
  } catch {
    // Return defaults
  }
  return {
    hits: 0,
    misses: 0,
    entries: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function saveCacheStats(stats: CacheStats): void {
  ensureCacheDir()
  writeFileSync(CACHE_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8')
}

async function cacheList(): Promise<void> {
  ensureCacheDir()
  const files = existsSync(CACHE_DIR)
    ? readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && f !== 'stats.json')
    : []

  const stats = loadCacheStats()
  console.log(`Stagehand Cache: ${CACHE_DIR}`)
  console.log(`Total entries: ${files.length}`)
  console.log(`Hit rate: ${stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0}%`)
  console.log('')

  if (files.length === 0) {
    console.log('(no cached entries)')
    return
  }

  for (const file of files.slice(0, 20)) {
    const filePath = join(CACHE_DIR, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const entry = JSON.parse(raw) as Record<string, unknown>
      const instruction = typeof entry.instruction === 'string' ? entry.instruction : file
      const url = typeof entry.url === 'string' ? entry.url : 'unknown'
      console.log(`  [${file.slice(0, 8)}] "${instruction.slice(0, 60)}" @ ${url}`)
    } catch {
      console.log(`  [${file}] (unreadable)`)
    }
  }

  if (files.length > 20) {
    console.log(`  ... and ${files.length - 20} more`)
  }
}

async function cacheClear(): Promise<void> {
  ensureCacheDir()
  let removed = 0

  if (existsSync(CACHE_DIR)) {
    const files = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(join(CACHE_DIR, file))
        removed++
      } catch {
        // Skip files we can't remove
      }
    }
  }

  // Reset stats
  saveCacheStats({
    hits: 0,
    misses: 0,
    entries: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  console.log(`Stagehand Cache: Cleared ${removed} entries`)
}

async function cacheStats(): Promise<void> {
  const stats = loadCacheStats()
  const total = stats.hits + stats.misses
  const hitRate = total > 0 ? Math.round((stats.hits / total) * 100) : 0

  console.log(`Stagehand Cache Statistics:`)
  console.log(`  Directory: ${CACHE_DIR}`)
  console.log(`  Entries: ${stats.entries}`)
  console.log(`  Cache hits: ${stats.hits}`)
  console.log(`  Cache misses: ${stats.misses}`)
  console.log(`  Hit rate: ${hitRate}%`)
  console.log(`  Created: ${stats.createdAt}`)
  console.log(`  Last updated: ${stats.updatedAt}`)
}

// ============================================
// STAGEHAND INITIALIZATION
// ============================================

interface InitOptions {
  useExistingSession: boolean
  navigateUrl?: string
}

async function initStagehand(opts: InitOptions): Promise<Stagehand> {
  const { model } = getStagehandConfig()

  ensureCacheDir()

  const v3Options: V3Options = {
    env: 'LOCAL',
    model,
    verbose: 0,
    disablePino: true,
    cacheDir: CACHE_DIR,
    logger: () => {
      // Suppress internal Stagehand logging - we handle our own output
    },
  }

  // When --session browse is passed, connect to existing Browse.ts session via CDP
  if (opts.useExistingSession) {
    const cdpUrl = `http://localhost:${CDP_PORT}`
    // Check if Browse.ts session is running
    try {
      const res = await fetch(`${cdpUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (!res.ok) {
        throw new Error('Browse.ts session not responding')
      }
    } catch {
      throw new Error(
        `No Browse.ts session found at port ${CDP_PORT}. Run: bun run Browse.ts <url> first`
      )
    }

    // Connect to the existing browser via CDP WebSocket
    // BrowserSession.ts serves on port 9222 — Playwright DevTools protocol endpoint
    v3Options.localBrowserLaunchOptions = {
      cdpUrl: `ws://localhost:${CDP_PORT}`,
    }

    console.log(`Stagehand: Connecting to existing Browse.ts session via CDP (port ${CDP_PORT})`)
  } else {
    // Launch a fresh headless browser
    v3Options.localBrowserLaunchOptions = {
      headless: true,
    }
  }

  const initStart = Date.now()
  const stagehand = new Stagehand(v3Options)
  await stagehand.init()
  console.log(`Stagehand: init completed in ${Date.now() - initStart}ms`)

  // Navigate to URL if provided (skip if CDP session is already on the target URL)
  if (opts.navigateUrl) {
    const currentPage = stagehand.context.pages[0]
    const currentUrl = currentPage?.url() ?? ''
    if (currentUrl === opts.navigateUrl || currentUrl === `${opts.navigateUrl}/`) {
      console.log(`Stagehand: Already on ${opts.navigateUrl}, skipping navigation`)
    } else {
      const navStart = Date.now()
      console.log(`Stagehand: Navigating to ${opts.navigateUrl}`)
      await currentPage?.goto(opts.navigateUrl)
      console.log(`Stagehand: Navigation completed in ${Date.now() - navStart}ms`)
    }
  }

  return stagehand
}

// ============================================
// COMMANDS
// ============================================

async function runAct(instruction: string, opts: InitOptions): Promise<void> {
  console.log(`Stagehand Act: "${instruction}"`)

  const stagehand = await initStagehand(opts)
  try {
    const result = await stagehand.act(instruction)

    if (result.success) {
      console.log(`Stagehand Result: Action completed successfully`)
      if (result.description) {
        console.log(`  Description: ${result.description}`)
      }
      if (result.action) {
        console.log(`  Action: ${result.action}`)
      }
    } else {
      console.log(`Stagehand Result: Action failed`)
      if (result.description) {
        console.log(`  Reason: ${result.description}`)
      }
      process.exitCode = 1
    }
  } finally {
    if (!opts.useExistingSession) {
      await stagehand.close()
    }
  }
}

async function runExtract(instruction: string, schemaArg: string | undefined, opts: InitOptions): Promise<void> {
  console.log(`Stagehand Extract: "${instruction}"`)

  const stagehand = await initStagehand(opts)
  try {
    let result: unknown

    if (schemaArg) {
      // Parse the JSON schema argument and convert to Zod
      let rawSchema: Record<string, unknown>
      try {
        rawSchema = JSON.parse(schemaArg) as Record<string, unknown>
      } catch {
        throw new Error(`Invalid --schema JSON: ${schemaArg}`)
      }

      // Build a Zod schema from the flat JSON type map
      // Supports: "string", "number", "boolean", "string[]", "number[]"
      const zodFields: Record<string, z.ZodTypeAny> = {}
      for (const [key, typeStr] of Object.entries(rawSchema)) {
        const t = String(typeStr)
        if (t === 'string') zodFields[key] = z.string().optional()
        else if (t === 'number') zodFields[key] = z.number().optional()
        else if (t === 'boolean') zodFields[key] = z.boolean().optional()
        else if (t === 'string[]') zodFields[key] = z.array(z.string()).optional()
        else if (t === 'number[]') zodFields[key] = z.array(z.number()).optional()
        else zodFields[key] = z.string().optional()
      }

      const zodSchema = z.object(zodFields)
      result = await stagehand.extract(instruction, zodSchema)

      // Guard against null values in schema results (Stagehand SDK bug: model may return null for typed fields)
      if (result && typeof result === 'object') {
        for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
          if (value === null || value === undefined) {
            const expectedType = String(rawSchema[key])
            if (expectedType.endsWith('[]')) {
              (result as Record<string, unknown>)[key] = []
            } else if (expectedType === 'number') {
              (result as Record<string, unknown>)[key] = 0
            } else if (expectedType === 'boolean') {
              (result as Record<string, unknown>)[key] = false
            } else {
              (result as Record<string, unknown>)[key] = ''
            }
          }
        }
      }
    } else {
      result = await stagehand.extract(instruction)
    }

    console.log(`Stagehand Result:`)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    if (!opts.useExistingSession) {
      await stagehand.close()
    }
  }
}

async function runObserve(instruction: string, opts: InitOptions): Promise<void> {
  console.log(`Stagehand Observe: "${instruction}"`)

  const stagehand = await initStagehand(opts)
  try {
    const actions = await stagehand.observe(instruction)

    console.log(`Stagehand Result: ${actions.length} observations`)
    for (const action of actions) {
      console.log(`  - ${action.description ?? String(action)}`)
      if (action.selector) {
        console.log(`    selector: ${action.selector}`)
      }
    }
  } finally {
    if (!opts.useExistingSession) {
      await stagehand.close()
    }
  }
}

async function runAgent(task: string, opts: InitOptions): Promise<void> {
  console.log(`Stagehand Agent: "${task}"`)
  console.log(`Stagehand: Running autonomous multi-step task (CUA mode)...`)

  // Resolve CUA provider API keys
  const secrets = loadSecrets()

  // Try Anthropic key from secrets.json or env
  if (!process.env.ANTHROPIC_API_KEY) {
    const key = secrets.ANTHROPIC_API_KEY ?? ''
    if (key) process.env.ANTHROPIC_API_KEY = key
  }
  if (!process.env.OPENAI_API_KEY) {
    const key = secrets.OPENAI_API_KEY ?? ''
    if (key) process.env.OPENAI_API_KEY = key
  }

  // CUA model selection — prefer explicit override, then Anthropic if key available, else Gemini
  // Supported CUA models: anthropic/claude-sonnet-4-5-20250929, anthropic/claude-sonnet-4-20250514,
  // google/gemini-2.5-computer-use-preview-10-2025, openai/computer-use-preview
  let cuaModel = process.env.STAGEHAND_CUA_MODEL ?? ''
  if (!cuaModel) {
    if (process.env.ANTHROPIC_API_KEY) {
      cuaModel = 'anthropic/claude-sonnet-4-5-20250929'
    } else if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
      cuaModel = 'google/gemini-2.5-computer-use-preview-10-2025'
      console.log('Stagehand: No Anthropic key available, using Gemini CUA model')
    } else {
      console.error('Error: No API key available for any CUA provider.')
      console.error('Add ANTHROPIC_API_KEY or GEMINI_API_KEY to ~/.claude/secrets.json')
      process.exitCode = 1
      return
    }
  }

  // Validate key exists for explicitly chosen provider
  if (cuaModel.startsWith('anthropic/') && !process.env.ANTHROPIC_API_KEY) {
    console.error(`Error: CUA model "${cuaModel}" requires ANTHROPIC_API_KEY.`)
    console.error('Falling back to Gemini CUA model...')
    if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
      cuaModel = 'google/gemini-2.5-computer-use-preview-10-2025'
    } else {
      console.error('No fallback available. Add ANTHROPIC_API_KEY or GEMINI_API_KEY to ~/.claude/secrets.json')
      process.exitCode = 1
      return
    }
  }
  if (cuaModel.startsWith('openai/') && !process.env.OPENAI_API_KEY) {
    console.error(`Error: CUA model "${cuaModel}" requires OPENAI_API_KEY.`)
    process.exitCode = 1
    return
  }

  const stagehand = await initStagehand(opts)
  try {
    console.log(`Stagehand: CUA model: ${cuaModel}`)
    const agentInstance = stagehand.agent({
      mode: 'cua',
      model: cuaModel,
    } as Record<string, unknown>)
    const result = await agentInstance.execute(task)

    console.log(`Stagehand Result: Task completed`)
    console.log(`  Success: ${result.success}`)
    console.log(`  Message: ${result.message}`)

    if (result.completed) {
      console.log(`  Status: completed`)
    }

    if (result.actions && result.actions.length > 0) {
      console.log(`  Steps taken: ${result.actions.length}`)
      for (const action of result.actions.slice(0, 5)) {
        const desc = typeof action === 'object' && action !== null && 'description' in action
          ? String((action as Record<string, unknown>).description)
          : String(action)
        console.log(`    - ${desc}`)
      }
      if (result.actions.length > 5) {
        console.log(`    ... and ${result.actions.length - 5} more steps`)
      }
    }

    if (!result.success) {
      process.exitCode = 1
    }
  } finally {
    if (!opts.useExistingSession) {
      await stagehand.close()
    }
  }
}

// ============================================
// HELP
// ============================================

function showHelp(): void {
  console.log(`
Stagehand CLI v1.0.0 - AI-Driven Browser Automation

Usage:
  bun run Stagehand.ts act "<instruction>"           AI-driven natural language action
  bun run Stagehand.ts extract "<instruction>"       Extract structured data from page
  bun run Stagehand.ts observe "<instruction>"       Analyze page and return observations
  bun run Stagehand.ts agent "<task>"                Autonomous multi-step task execution
  bun run Stagehand.ts cache list|clear|stats        Cache management

Flags:
  --url <url>         Navigate to URL before action
  --session browse    Connect to existing Browse.ts session (CDP port 9222)
  --schema '<json>'   JSON type map for extract command (e.g. '{"name":"string"}')

Examples:
  bun run Stagehand.ts act "Click the login button"
  bun run Stagehand.ts act "Fill in the email field with test@example.com"
  bun run Stagehand.ts extract "Get all product names and prices"
  bun run Stagehand.ts extract "Get user info" --schema '{"name":"string","email":"string"}'
  bun run Stagehand.ts observe "What actions can I take on this page?"
  bun run Stagehand.ts observe "Is there a login form visible?"
  bun run Stagehand.ts agent "Log in with test@example.com / pass123, then go to settings"
  bun run Stagehand.ts --url https://example.com act "Click the first link"
  bun run Stagehand.ts --session browse act "Click submit"
  bun run Stagehand.ts cache list
  bun run Stagehand.ts cache clear
  bun run Stagehand.ts cache stats

When to use Stagehand vs Browse.ts:
  Browse.ts  - Known CSS/XPath selectors, screenshots, diagnostics, deterministic scripts
  Stagehand  - Unknown selectors, AI extraction, dynamic pages, multi-step autonomous tasks

LLM Provider:
  Default: Gemini Flash (cheapest, fastest)
  Fallback: Claude Sonnet
  Configure in ~/.claude/settings.json under "stagehand" key
  API keys from ~/.claude/secrets.json (GEMINI_API_KEY, ANTHROPIC_API_KEY)

Cache:
  Actions are cached at ~/.claude/MEMORY/stagehand-cache/
  First run: LLM inference + cache write (~$0.001-0.01, ~2s)
  Cached run: Replay without LLM call ($0.00, ~100ms)
  `)
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string' },
      session: { type: 'string' },
      schema: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  })

  if (values.help || positionals.length === 0) {
    showHelp()
    return
  }

  const command = positionals[0]
  const useExistingSession = values.session === 'browse'
  const navigateUrl = values.url

  const initOpts: InitOptions = {
    useExistingSession,
    navigateUrl,
  }

  try {
    switch (command) {
      case 'act': {
        const instruction = positionals.slice(1).join(' ')
        if (!instruction) {
          console.error('Error: instruction required for act command')
          console.error('Usage: bun run Stagehand.ts act "<instruction>"')
          process.exit(1)
        }
        await runAct(instruction, initOpts)
        break
      }

      case 'extract': {
        const instruction = positionals.slice(1).join(' ')
        if (!instruction) {
          console.error('Error: instruction required for extract command')
          console.error('Usage: bun run Stagehand.ts extract "<instruction>"')
          process.exit(1)
        }
        await runExtract(instruction, values.schema, initOpts)
        break
      }

      case 'observe': {
        const instruction = positionals.slice(1).join(' ')
        if (!instruction) {
          console.error('Error: instruction required for observe command')
          console.error('Usage: bun run Stagehand.ts observe "<instruction>"')
          process.exit(1)
        }
        await runObserve(instruction, initOpts)
        break
      }

      case 'agent': {
        const task = positionals.slice(1).join(' ')
        if (!task) {
          console.error('Error: task required for agent command')
          console.error('Usage: bun run Stagehand.ts agent "<task>"')
          process.exit(1)
        }
        await runAgent(task, initOpts)
        break
      }

      case 'cache': {
        const subCommand = positionals[1]
        switch (subCommand) {
          case 'list':
            await cacheList()
            break
          case 'clear':
            await cacheClear()
            break
          case 'stats':
            await cacheStats()
            break
          default:
            console.error(`Unknown cache subcommand: ${subCommand}`)
            console.error('Usage: bun run Stagehand.ts cache list|clear|stats')
            process.exit(1)
        }
        break
      }

      case 'help':
      case '--help':
        showHelp()
        break

      default:
        console.error(`Unknown command: ${command}`)
        console.error('Run with --help for usage')
        process.exit(1)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Stagehand Error: ${message}`)
    process.exit(1)
  }
}

main()
