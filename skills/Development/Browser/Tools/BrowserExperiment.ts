#!/usr/bin/env bun
/**
 * BrowserExperiment.ts v1.0.0 - Browse.ts vs Stagehand Experiment Harness
 *
 * Runs controlled experiments comparing Browse.ts (deterministic) vs Stagehand.ts (AI-driven)
 * across 10 test scenarios to generate data-driven routing rules.
 *
 * Usage:
 *   bun run BrowserExperiment.ts run              # Run all experiments
 *   bun run BrowserExperiment.ts run --scenario 1 # Run single scenario
 *   bun run BrowserExperiment.ts report           # Generate report from saved results
 *
 * Test sites used (all publicly accessible, no credentials required):
 *   https://example.com               - basic navigation
 *   https://the-internet.herokuapp.com - forms, dropdowns, dynamic content
 *   https://httpbin.org               - request testing
 *   https://books.toscrape.com        - product data extraction
 *   https://demoqa.com                - form elements, buttons, dropdowns
 */

import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

// ============================================
// CONSTANTS
// ============================================

const BROWSE_TS = join(homedir(), '.claude', 'skills', 'Browser', 'Tools', 'Browse.ts')
const STAGEHAND_TS = join(homedir(), '.claude', 'skills', 'Browser', 'Tools', 'Stagehand.ts')
const RESULTS_DIR = join(homedir(), '.claude', 'MEMORY', 'experiments')
const RESULTS_FILE = join(RESULTS_DIR, `browser-automation-${new Date().toISOString().slice(0, 10)}.json`)

// ============================================
// TYPES
// ============================================

interface ExperimentResult {
  scenario: string
  tool: 'browse' | 'stagehand'
  run: number
  tokensConsumed: number
  wallClockMs: number
  success: boolean
  failureMode?: string
  llmCost: number
  selfHealed: boolean
  notes?: string
}

interface ScenarioDefinition {
  id: number
  name: string
  description: string
  category: string
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  wallClockMs: number
}

// ============================================
// SCENARIOS
// ============================================

const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 1,
    name: 'Navigate and screenshot',
    description: 'Go to https://example.com, take screenshot',
    category: 'Basic',
  },
  {
    id: 2,
    name: 'Fill a login form',
    description: 'Navigate to login form page, fill fields, submit',
    category: 'Form filling',
  },
  {
    id: 3,
    name: 'Multi-step navigation',
    description: 'Navigate through 3+ pages following links',
    category: 'Navigation',
  },
  {
    id: 4,
    name: 'Extract product data',
    description: 'Get structured data from books.toscrape.com',
    category: 'Data extraction',
  },
  {
    id: 5,
    name: 'Complex SPA interaction',
    description: 'Interact with dynamic page on demoqa.com',
    category: 'SPA interaction',
  },
  {
    id: 6,
    name: 'Visual verification',
    description: 'Load page, verify specific elements exist',
    category: 'QA',
  },
  {
    id: 7,
    name: 'Dynamic dropdown',
    description: 'Interact with JS-rendered dropdown on demoqa.com',
    category: 'Dynamic UI',
  },
  {
    id: 8,
    name: 'Authenticated flow',
    description: 'Save and restore browser state',
    category: 'Auth',
  },
  {
    id: 9,
    name: 'Error recovery',
    description: 'Attempt action on a changed/missing element',
    category: 'Resilience',
  },
  {
    id: 10,
    name: 'Batch operations',
    description: '10 sequential click/navigation operations',
    category: 'Throughput',
  },
]

// ============================================
// UTILITIES
// ============================================

function log(msg: string): void {
  console.log(`[BrowserExperiment] ${msg}`)
}

function estimateTokens(text: string): number {
  // Rough token estimation: ~4 chars per token on average
  return Math.ceil(text.length / 4)
}

function ensureResultsDir(): void {
  mkdirSync(RESULTS_DIR, { recursive: true })
}

async function runCommand(args: string[], timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''

    const child = spawn('bun', ['run', ...args], {
      env: process.env as Record<string, string>,
      timeout: timeoutMs,
    })

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        wallClockMs: Date.now() - start,
      })
    })

    child.on('error', (err) => {
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: 1,
        wallClockMs: Date.now() - start,
      })
    })
  })
}

// ============================================
// SCENARIO RUNNERS - Browse.ts
// ============================================

async function runBrowseScenario(scenarioId: number, run: number): Promise<ExperimentResult> {
  const baseResult: Omit<ExperimentResult, 'success' | 'wallClockMs' | 'tokensConsumed'> = {
    scenario: SCENARIOS[scenarioId - 1].name,
    tool: 'browse',
    run,
    llmCost: 0, // Browse.ts has no LLM cost
    selfHealed: false,
  }

  let result: RunResult
  let success = false
  let failureMode: string | undefined
  let notes: string | undefined

  switch (scenarioId) {
    case 1: {
      // Navigate and screenshot - simple URL visit
      result = await runCommand([BROWSE_TS, 'https://example.com'])
      success = result.exitCode === 0 && result.stdout.includes('loaded')
      if (!success) failureMode = result.stderr || 'Navigation failed'
      notes = 'Basic navigate + auto-screenshot on URL visit'
      break
    }

    case 2: {
      // Fill a login form - the-internet.herokuapp.com/login
      result = await runCommand([BROWSE_TS, 'https://the-internet.herokuapp.com/login'])
      const navOk = result.exitCode === 0

      if (navOk) {
        const fillResult = await runCommand([
          BROWSE_TS, 'fill', '#username', 'tomsmith',
        ])
        const fillPass = await runCommand([
          BROWSE_TS, 'fill', '#password', 'SuperSecretPassword!',
        ])
        const clickResult = await runCommand([
          BROWSE_TS, 'click', 'button[type="submit"]',
        ])
        success = fillResult.exitCode === 0 && fillPass.exitCode === 0 && clickResult.exitCode === 0
        result = {
          stdout: result.stdout + fillResult.stdout + fillPass.stdout + clickResult.stdout,
          stderr: result.stderr + fillResult.stderr,
          exitCode: success ? 0 : 1,
          wallClockMs: result.wallClockMs + fillResult.wallClockMs + fillPass.wallClockMs + clickResult.wallClockMs,
        }
      } else {
        success = false
        failureMode = 'Navigation to login page failed'
      }
      notes = 'Fill username/password form and click submit'
      break
    }

    case 3: {
      // Multi-step navigation - follow links on example.com
      result = await runCommand([BROWSE_TS, 'https://example.com'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout
      let combinedErr = result.stderr

      // Click "More information" link which goes to iana.org
      const click1 = await runCommand([BROWSE_TS, 'click', 'a[href*="iana"]'])
      totalMs += click1.wallClockMs
      combinedOut += click1.stdout
      combinedErr += click1.stderr

      // Now navigate to httpbin.org
      const nav2 = await runCommand([BROWSE_TS, 'https://httpbin.org'])
      totalMs += nav2.wallClockMs
      combinedOut += nav2.stdout
      combinedErr += nav2.stderr

      // Navigate to httpbin /get endpoint
      const nav3 = await runCommand([BROWSE_TS, 'https://httpbin.org/get'])
      totalMs += nav3.wallClockMs
      combinedOut += nav3.stdout
      combinedErr += nav3.stderr

      success = result.exitCode === 0 && nav2.exitCode === 0 && nav3.exitCode === 0
      if (!success) failureMode = combinedErr || 'One or more navigation steps failed'
      result = {
        stdout: combinedOut,
        stderr: combinedErr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = '3-step navigation: example.com -> iana.org -> httpbin.org -> /get'
      break
    }

    case 4: {
      // Extract product data - books.toscrape.com
      result = await runCommand([BROWSE_TS, 'https://books.toscrape.com'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      // Use eval to extract book titles from the page
      const evalResult = await runCommand([
        BROWSE_TS, 'eval',
        'JSON.stringify(Array.from(document.querySelectorAll(".product_pod h3 a")).slice(0,5).map(a => ({title: a.getAttribute("title"), href: a.href})))',
      ])
      totalMs += evalResult.wallClockMs
      combinedOut += evalResult.stdout

      success = result.exitCode === 0 && evalResult.exitCode === 0 && evalResult.stdout.includes('[')
      if (!success) failureMode = evalResult.stderr || 'Data extraction via eval failed'
      result = {
        stdout: combinedOut,
        stderr: result.stderr + evalResult.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = 'Extract book titles from books.toscrape.com via JS eval'
      break
    }

    case 5: {
      // Complex SPA - demoqa.com buttons page
      result = await runCommand([BROWSE_TS, 'https://demoqa.com/buttons'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      // Double-click the "Double Click Me" button
      const clickResult = await runCommand([
        BROWSE_TS, 'click', '#doubleClickBtn',
      ])
      totalMs += clickResult.wallClockMs
      combinedOut += clickResult.stdout

      // Check the result message via eval
      const evalResult = await runCommand([
        BROWSE_TS, 'eval',
        'document.querySelector("#doubleClickMessage")?.textContent ?? "not found"',
      ])
      totalMs += evalResult.wallClockMs
      combinedOut += evalResult.stdout

      success = result.exitCode === 0 && clickResult.exitCode === 0
      if (!success) failureMode = clickResult.stderr || 'Button click on SPA failed'
      result = {
        stdout: combinedOut,
        stderr: result.stderr + clickResult.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = 'Interact with demoqa.com buttons SPA page'
      break
    }

    case 6: {
      // Visual verification - check element exists on page
      result = await runCommand([BROWSE_TS, 'https://example.com'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      // Verify the h1 and paragraph exist via eval
      const verifyResult = await runCommand([
        BROWSE_TS, 'eval',
        'JSON.stringify({h1: document.querySelector("h1")?.textContent?.trim(), hasLink: !!document.querySelector("a[href]")})',
      ])
      totalMs += verifyResult.wallClockMs
      combinedOut += verifyResult.stdout

      // Take a screenshot as visual proof
      const screenshotResult = await runCommand([
        BROWSE_TS, 'screenshot', `/tmp/browse-verify-${Date.now()}.png`,
      ])
      totalMs += screenshotResult.wallClockMs
      combinedOut += screenshotResult.stdout

      const verifyOutput = verifyResult.stdout
      success = verifyResult.exitCode === 0 &&
        verifyOutput.includes('Example Domain') &&
        screenshotResult.exitCode === 0
      if (!success) failureMode = 'Visual verification elements not found'
      result = {
        stdout: combinedOut,
        stderr: result.stderr + verifyResult.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = 'Verify h1 text and link presence on example.com, take screenshot'
      break
    }

    case 7: {
      // Dynamic dropdown - demoqa.com/select-menu
      result = await runCommand([BROWSE_TS, 'https://demoqa.com/select-menu'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      // Use eval to interact with the select element
      const evalSelect = await runCommand([
        BROWSE_TS, 'eval',
        'const el = document.querySelector("#oldSelectMenu"); if(el) { el.value = "1"; el.dispatchEvent(new Event("change")); el.options[el.selectedIndex]?.text } else "not found"',
      ])
      totalMs += evalSelect.wallClockMs
      combinedOut += evalSelect.stdout

      success = result.exitCode === 0 && evalSelect.exitCode === 0
      if (!success) failureMode = evalSelect.stderr || 'Dropdown interaction failed'
      result = {
        stdout: combinedOut,
        stderr: result.stderr + evalSelect.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = 'Interact with JS-rendered select dropdown on demoqa.com/select-menu'
      break
    }

    case 8: {
      // Authenticated flow - save and restore state
      // Navigate to a page, save state, reload, verify state restored
      result = await runCommand([BROWSE_TS, 'https://example.com'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      const stateName = `test-state-${Date.now()}`
      const saveResult = await runCommand([BROWSE_TS, 'state-save', stateName])
      totalMs += saveResult.wallClockMs
      combinedOut += saveResult.stdout

      // Navigate away
      const navAway = await runCommand([BROWSE_TS, 'https://httpbin.org'])
      totalMs += navAway.wallClockMs
      combinedOut += navAway.stdout

      // Load state back
      const loadResult = await runCommand([BROWSE_TS, 'state-load', stateName])
      totalMs += loadResult.wallClockMs
      combinedOut += loadResult.stdout

      success = saveResult.exitCode === 0 && loadResult.exitCode === 0
      if (!success) failureMode = saveResult.stderr || loadResult.stderr || 'State save/load failed'
      result = {
        stdout: combinedOut,
        stderr: result.stderr + saveResult.stderr + loadResult.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = 'Save browser state, navigate away, restore state'
      break
    }

    case 9: {
      // Error recovery - attempt click on non-existent element
      result = await runCommand([BROWSE_TS, 'https://example.com'])
      let totalMs = result.wallClockMs
      let combinedOut = result.stdout

      // Try to click a selector that doesn't exist - expect failure
      const badClick = await runCommand([BROWSE_TS, 'click', '#non-existent-element-xyz'])
      totalMs += badClick.wallClockMs
      combinedOut += badClick.stdout

      // Browse.ts will fail here - that's expected for this scenario
      // Measure recovery: fall back to a working click
      const goodClick = await runCommand([BROWSE_TS, 'click', 'a'])
      totalMs += goodClick.wallClockMs
      combinedOut += goodClick.stdout

      // Success means we recovered with a fallback action
      success = goodClick.exitCode === 0
      const selfHealed = badClick.exitCode !== 0 && goodClick.exitCode === 0

      result = {
        stdout: combinedOut,
        stderr: result.stderr + badClick.stderr + goodClick.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }

      if (!success) failureMode = 'Both primary and fallback actions failed'
      notes = `Browse.ts fails on bad selector (exitCode=${badClick.exitCode}), then succeeds on fallback. selfHealed=${selfHealed}`

      return {
        ...baseResult,
        success,
        failureMode,
        wallClockMs: totalMs,
        tokensConsumed: estimateTokens(combinedOut),
        selfHealed,
        notes,
      }
    }

    case 10: {
      // Batch operations - 10 sequential navigations
      let totalMs = 0
      let combinedOut = ''
      let combinedErr = ''
      let allSucceeded = true

      const urls = [
        'https://example.com',
        'https://httpbin.org/get',
        'https://httpbin.org/post',
        'https://httpbin.org/headers',
        'https://httpbin.org/ip',
        'https://httpbin.org/user-agent',
        'https://httpbin.org/status/200',
        'https://httpbin.org/json',
        'https://httpbin.org/uuid',
        'https://httpbin.org/anything',
      ]

      for (const url of urls) {
        const r = await runCommand([BROWSE_TS, 'navigate', url], 30000)
        totalMs += r.wallClockMs
        combinedOut += r.stdout
        combinedErr += r.stderr
        if (r.exitCode !== 0) allSucceeded = false
      }

      success = allSucceeded
      if (!success) failureMode = 'One or more batch navigations failed'
      result = {
        stdout: combinedOut,
        stderr: combinedErr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = `10 sequential navigations. Total time: ${totalMs}ms`
      break
    }

    default:
      throw new Error(`Unknown scenario ID: ${scenarioId}`)
  }

  return {
    ...baseResult,
    success,
    failureMode,
    wallClockMs: result.wallClockMs,
    tokensConsumed: estimateTokens(result.stdout),
    notes,
  }
}

// ============================================
// SCENARIO RUNNERS - Stagehand.ts
// ============================================

async function runStagehandScenario(scenarioId: number, run: number): Promise<ExperimentResult> {
  const baseResult: Omit<ExperimentResult, 'success' | 'wallClockMs' | 'tokensConsumed'> = {
    scenario: SCENARIOS[scenarioId - 1].name,
    tool: 'stagehand',
    run,
    llmCost: 0, // Will be non-zero for LLM calls (estimated at $0.001 per action for Gemini Flash)
    selfHealed: false,
  }

  const LLM_COST_PER_ACTION = 0.001 // ~$0.001 per action for Gemini Flash

  let result: RunResult
  let success = false
  let failureMode: string | undefined
  let notes: string | undefined
  let llmCost = 0

  switch (scenarioId) {
    case 1: {
      // Navigate and screenshot - Stagehand navigates then screenshot via Browse.ts
      result = await runCommand([
        STAGEHAND_TS, '--url', 'https://example.com',
        'observe', 'What is the main heading on this page?',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Stagehand Result')
      if (!success) failureMode = result.stderr || 'Stagehand navigation/observe failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'Stagehand navigates + observe to analyze page content'
      break
    }

    case 2: {
      // Fill login form using Stagehand act
      result = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://the-internet.herokuapp.com/login',
        'act', 'Fill the username field with "tomsmith" and the password field with "SuperSecretPassword!" then click the login button',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Action completed')
      if (!success) failureMode = result.stderr || result.stdout || 'Form fill action failed'
      llmCost = LLM_COST_PER_ACTION * 2 // Multiple field fills
      notes = 'AI-driven form fill using natural language instruction'
      break
    }

    case 3: {
      // Multi-step navigation using Stagehand act commands in sequence
      // Navigate to example.com, click the link, then observe next page
      const nav1 = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://example.com',
        'act', 'Click the "More information" link',
      ], 60000)
      let totalMs = nav1.wallClockMs
      let combinedOut = nav1.stdout

      // Observe what's on the next page (shares session)
      const observe1 = await runCommand([
        STAGEHAND_TS,
        'observe', 'What organization runs this page and what is the main topic?',
      ], 60000)
      totalMs += observe1.wallClockMs
      combinedOut += observe1.stdout

      // Navigate to a third page via act
      const nav2 = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://httpbin.org',
        'observe', 'What API testing features are listed on this page?',
      ], 60000)
      totalMs += nav2.wallClockMs
      combinedOut += nav2.stdout

      success = nav1.exitCode === 0 && observe1.exitCode === 0 && nav2.exitCode === 0
      if (!success) failureMode = nav1.stderr || observe1.stderr || 'Multi-step Stagehand navigation failed'
      result = {
        stdout: combinedOut,
        stderr: nav1.stderr + observe1.stderr + nav2.stderr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      llmCost = LLM_COST_PER_ACTION * 3 // 3 LLM calls
      notes = 'Sequential act+observe across 3 pages using Stagehand'
      break
    }

    case 4: {
      // Extract product data - use no schema (let Stagehand infer)
      result = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://books.toscrape.com',
        'extract', 'List the titles and prices of books visible on this page',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Stagehand Result')
      if (!success) failureMode = result.stderr || 'Data extraction failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'AI-driven extraction of book data (no schema)'
      break
    }

    case 5: {
      // Complex SPA interaction
      result = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://demoqa.com/buttons',
        'act', 'Click the button that says "Double Click Me"',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Action completed')
      if (!success) failureMode = result.stderr || 'SPA button interaction failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'AI finds and clicks dynamic button by natural language description'
      break
    }

    case 6: {
      // Visual verification
      result = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://example.com',
        'observe', 'What is the main heading? Is there a link present? What does the page describe?',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Stagehand Result')
      if (!success) failureMode = result.stderr || 'Visual verification observation failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'AI observes and describes page content for verification'
      break
    }

    case 7: {
      // Dynamic dropdown
      result = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://demoqa.com/select-menu',
        'act', 'Select the "Volvo" option from the old style select menu',
      ])
      success = result.exitCode === 0 && result.stdout.includes('Action completed')
      if (!success) failureMode = result.stderr || 'Dropdown selection failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'AI-driven dropdown interaction using natural language'
      break
    }

    case 8: {
      // Authenticated flow - Stagehand observe after Browse.ts state load
      // First establish state with Browse.ts
      const browseNav = await runCommand([BROWSE_TS, 'https://example.com'])
      const stateName = `stagehand-test-state-${Date.now()}`
      const browseSave = await runCommand([BROWSE_TS, 'state-save', stateName])

      // Now use Stagehand to verify current state
      result = await runCommand([
        STAGEHAND_TS,
        '--session', 'browse',
        'observe', 'What page are we currently on?',
      ])

      const totalMs = browseNav.wallClockMs + browseSave.wallClockMs + result.wallClockMs
      success = browseSave.exitCode === 0 && result.exitCode === 0
      if (!success) failureMode = browseSave.stderr || result.stderr || 'State + observe workflow failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'Save state with Browse.ts, observe current page with Stagehand using shared session'

      return {
        ...baseResult,
        success,
        failureMode,
        wallClockMs: totalMs,
        tokensConsumed: estimateTokens(browseNav.stdout + browseSave.stdout + result.stdout),
        llmCost,
        notes,
      }
    }

    case 9: {
      // Error recovery - Stagehand's self-healing
      // Ask Stagehand to find an element that doesn't quite exist with exact wording
      const firstAttempt = await runCommand([
        STAGEHAND_TS,
        '--url', 'https://example.com',
        'act', 'Click the "contact us" link or any navigation link if contact is not found',
      ])

      const selfHealed = firstAttempt.exitCode === 0 &&
        (firstAttempt.stdout.includes('Action completed') || firstAttempt.stdout.includes('self-heal'))

      result = firstAttempt
      success = result.exitCode === 0
      if (!success) failureMode = result.stderr || 'Self-healing action failed'
      llmCost = LLM_COST_PER_ACTION
      notes = 'Stagehand attempts flexible element finding with natural language fallback'

      return {
        ...baseResult,
        success,
        failureMode,
        wallClockMs: result.wallClockMs,
        tokensConsumed: estimateTokens(result.stdout),
        llmCost,
        selfHealed,
        notes,
      }
    }

    case 10: {
      // Batch operations - 10 sequential Stagehand observations
      let totalMs = 0
      let combinedOut = ''
      let combinedErr = ''
      let llmCallCount = 0
      let allSucceeded = true

      const pages = [
        { url: 'https://example.com', observe: 'What is the page title?' },
        { url: 'https://httpbin.org/get', observe: 'What JSON data is shown?' },
        { url: 'https://httpbin.org/headers', observe: 'What headers are listed?' },
        { url: 'https://httpbin.org/ip', observe: 'What IP address is shown?' },
        { url: 'https://httpbin.org/user-agent', observe: 'What user agent is listed?' },
        { url: 'https://httpbin.org/json', observe: 'Describe the JSON structure' },
        { url: 'https://httpbin.org/uuid', observe: 'What UUID is shown?' },
        { url: 'https://httpbin.org/anything', observe: 'What request method is shown?' },
        { url: 'https://books.toscrape.com', observe: 'How many books are visible?' },
        { url: 'https://example.com', observe: 'Is there a link on the page?' },
      ]

      for (const { url, observe } of pages) {
        const r = await runCommand([
          STAGEHAND_TS,
          '--url', url,
          'observe', observe,
        ], 60000)
        totalMs += r.wallClockMs
        combinedOut += r.stdout
        combinedErr += r.stderr
        llmCallCount++
        if (r.exitCode !== 0) allSucceeded = false
      }

      success = allSucceeded
      llmCost = LLM_COST_PER_ACTION * llmCallCount
      if (!success) failureMode = 'One or more batch Stagehand operations failed'
      result = {
        stdout: combinedOut,
        stderr: combinedErr,
        exitCode: success ? 0 : 1,
        wallClockMs: totalMs,
      }
      notes = `10 sequential Stagehand observe operations. LLM calls: ${llmCallCount}`
      break
    }

    default:
      throw new Error(`Unknown scenario ID: ${scenarioId}`)
  }

  return {
    ...baseResult,
    success,
    failureMode,
    wallClockMs: result.wallClockMs,
    tokensConsumed: estimateTokens(result.stdout),
    llmCost,
    notes,
  }
}

// ============================================
// EXPERIMENT RUNNER
// ============================================

async function runExperiment(scenarioId: number, runsPerTool = 1): Promise<ExperimentResult[]> {
  const scenario = SCENARIOS[scenarioId - 1]
  log(`\nScenario ${scenarioId}: ${scenario.name} [${scenario.category}]`)
  log(`Description: ${scenario.description}`)
  log(`Running ${runsPerTool} run(s) per tool...`)

  const results: ExperimentResult[] = []

  for (let run = 1; run <= runsPerTool; run++) {
    log(`  Browse.ts run ${run}/${runsPerTool}...`)
    try {
      const browseResult = await runBrowseScenario(scenarioId, run)
      results.push(browseResult)
      const status = browseResult.success ? 'OK' : `FAIL (${browseResult.failureMode})`
      log(`    Browse.ts: ${status} | ${browseResult.wallClockMs}ms | ${browseResult.tokensConsumed} tokens`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log(`    Browse.ts: ERROR - ${message}`)
      results.push({
        scenario: scenario.name,
        tool: 'browse',
        run,
        tokensConsumed: 0,
        wallClockMs: 0,
        success: false,
        failureMode: `Exception: ${message}`,
        llmCost: 0,
        selfHealed: false,
        notes: 'Threw exception during test',
      })
    }

    log(`  Stagehand run ${run}/${runsPerTool}...`)
    try {
      const stagehandResult = await runStagehandScenario(scenarioId, run)
      results.push(stagehandResult)
      const status = stagehandResult.success ? 'OK' : `FAIL (${stagehandResult.failureMode})`
      log(`    Stagehand: ${status} | ${stagehandResult.wallClockMs}ms | ${stagehandResult.tokensConsumed} tokens | $${stagehandResult.llmCost.toFixed(4)} LLM cost`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log(`    Stagehand: ERROR - ${message}`)
      results.push({
        scenario: scenario.name,
        tool: 'stagehand',
        run,
        tokensConsumed: 0,
        wallClockMs: 0,
        success: false,
        failureMode: `Exception: ${message}`,
        llmCost: 0,
        selfHealed: false,
        notes: 'Threw exception during test',
      })
    }
  }

  return results
}

// ============================================
// REPORT GENERATOR
// ============================================

function generateReport(results: ExperimentResult[]): string {
  const lines: string[] = []

  lines.push('# Browser Automation Experiment Report')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  // Group by scenario
  const byScenario = new Map<string, ExperimentResult[]>()
  for (const r of results) {
    const key = r.scenario
    if (!byScenario.has(key)) byScenario.set(key, [])
    byScenario.get(key)!.push(r)
  }

  lines.push('## Summary by Scenario')
  lines.push('')
  lines.push('| # | Scenario | Browse.ts | Stagehand | Winner | Notes |')
  lines.push('|---|----------|-----------|-----------|--------|-------|')

  let scenarioIdx = 0
  for (const [scenario, scenarioResults] of byScenario) {
    scenarioIdx++
    const browseResults = scenarioResults.filter(r => r.tool === 'browse')
    const stagehandResults = scenarioResults.filter(r => r.tool === 'stagehand')

    const browseSuccess = browseResults.filter(r => r.success).length
    const stagehandSuccess = stagehandResults.filter(r => r.success).length
    const browseTotal = browseResults.length
    const stagehandTotal = stagehandResults.length

    const browseAvgMs = browseResults.length > 0
      ? Math.round(browseResults.reduce((s, r) => s + r.wallClockMs, 0) / browseResults.length)
      : 0
    const stagehandAvgMs = stagehandResults.length > 0
      ? Math.round(stagehandResults.reduce((s, r) => s + r.wallClockMs, 0) / stagehandResults.length)
      : 0

    const browseLabel = browseTotal > 0
      ? `${browseSuccess}/${browseTotal} ${browseAvgMs}ms`
      : 'N/A'
    const stagehandLabel = stagehandTotal > 0
      ? `${stagehandSuccess}/${stagehandTotal} ${stagehandAvgMs}ms`
      : 'N/A'

    let winner = 'Tie'
    if (browseSuccess > stagehandSuccess) winner = 'Browse.ts'
    else if (stagehandSuccess > browseSuccess) winner = 'Stagehand'
    else if (browseAvgMs < stagehandAvgMs && browseSuccess === stagehandSuccess) winner = 'Browse.ts (faster)'
    else if (stagehandAvgMs < browseAvgMs && browseSuccess === stagehandSuccess) winner = 'Stagehand (faster)'

    const notes = browseResults[0]?.notes?.slice(0, 50) ?? ''
    lines.push(`| ${scenarioIdx} | ${scenario} | ${browseLabel} | ${stagehandLabel} | ${winner} | ${notes} |`)
  }

  lines.push('')
  lines.push('## Detailed Results')
  lines.push('')

  for (const [scenario, scenarioResults] of byScenario) {
    lines.push(`### ${scenario}`)

    for (const r of scenarioResults) {
      const status = r.success ? 'PASS' : `FAIL`
      lines.push(`- **${r.tool}** run ${r.run}: ${status} | ${r.wallClockMs}ms | ${r.tokensConsumed} tokens | $${r.llmCost.toFixed(4)} LLM cost | selfHealed=${r.selfHealed}`)
      if (!r.success && r.failureMode) {
        lines.push(`  - Failure: ${r.failureMode}`)
      }
      if (r.notes) {
        lines.push(`  - Notes: ${r.notes}`)
      }
    }
    lines.push('')
  }

  lines.push('## Raw Totals')
  const browseAll = results.filter(r => r.tool === 'browse')
  const stagehandAll = results.filter(r => r.tool === 'stagehand')

  lines.push(`- **Browse.ts**: ${browseAll.filter(r => r.success).length}/${browseAll.length} success | avg ${Math.round(browseAll.reduce((s, r) => s + r.wallClockMs, 0) / (browseAll.length || 1))}ms | $0.00 LLM cost`)
  lines.push(`- **Stagehand**: ${stagehandAll.filter(r => r.success).length}/${stagehandAll.length} success | avg ${Math.round(stagehandAll.reduce((s, r) => s + r.wallClockMs, 0) / (stagehandAll.length || 1))}ms | $${stagehandAll.reduce((s, r) => s + r.llmCost, 0).toFixed(4)} LLM cost`)

  return lines.join('\n')
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      scenario: { type: 'string' },
      runs: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  })

  const command = positionals[0] ?? 'help'

  if (values.help || command === 'help') {
    console.log(`
BrowserExperiment.ts v1.0.0 - Browse.ts vs Stagehand Experiment Harness

Commands:
  run              Run all experiments (default: 1 run per tool per scenario)
  run --scenario N Run a single scenario (N = 1-10)
  report           Generate report from saved results

Options:
  --scenario N     Run only scenario N (1-10)
  --runs N         Number of runs per tool per scenario (default: 1)

Examples:
  bun run BrowserExperiment.ts run
  bun run BrowserExperiment.ts run --scenario 1
  bun run BrowserExperiment.ts run --runs 3
  bun run BrowserExperiment.ts report
`)
    return
  }

  ensureResultsDir()

  if (command === 'report') {
    if (!existsSync(RESULTS_FILE)) {
      // Look for any results file
      const files = require('node:fs').readdirSync(RESULTS_DIR).filter((f: string) => f.startsWith('browser-automation-'))
      if (files.length === 0) {
        console.error('No experiment results found. Run experiments first.')
        process.exit(1)
      }
      const latestFile = join(RESULTS_DIR, files[files.length - 1])
      const raw = readFileSync(latestFile, 'utf-8')
      const results = JSON.parse(raw) as ExperimentResult[]
      console.log(generateReport(results))
      return
    }

    const raw = readFileSync(RESULTS_FILE, 'utf-8')
    const results = JSON.parse(raw) as ExperimentResult[]
    console.log(generateReport(results))
    return
  }

  if (command === 'run') {
    const runsPerTool = parseInt(values.runs ?? '1', 10)
    const scenarioFilter = values.scenario ? parseInt(values.scenario, 10) : undefined

    log('Browser Automation Experiment Suite')
    log(`Results will be saved to: ${RESULTS_FILE}`)
    log(`Runs per tool per scenario: ${runsPerTool}`)

    const allResults: ExperimentResult[] = []

    const scenariosToRun = scenarioFilter
      ? SCENARIOS.filter(s => s.id === scenarioFilter)
      : SCENARIOS

    if (scenariosToRun.length === 0) {
      console.error(`No scenario found with ID ${scenarioFilter}. Valid IDs: 1-10`)
      process.exit(1)
    }

    for (const scenario of scenariosToRun) {
      const results = await runExperiment(scenario.id, runsPerTool)
      allResults.push(...results)

      // Save results incrementally
      writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2), 'utf-8')
    }

    log('\nAll experiments complete!')
    log(`Results saved to: ${RESULTS_FILE}`)
    log(`Total runs: ${allResults.length}`)
    log(`Browse.ts success: ${allResults.filter(r => r.tool === 'browse' && r.success).length}/${allResults.filter(r => r.tool === 'browse').length}`)
    log(`Stagehand success: ${allResults.filter(r => r.tool === 'stagehand' && r.success).length}/${allResults.filter(r => r.tool === 'stagehand').length}`)

    // Print summary report
    console.log('\n')
    console.log(generateReport(allResults))

    return
  }

  console.error(`Unknown command: ${command}`)
  console.error('Run with --help for usage')
  process.exit(1)
}

main()
