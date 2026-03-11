# Browser - Code-First Interface

**Direct Playwright code execution via Browse.ts CLI.**

## Why CLI over MCP?

| Approach | Tokens | Performance |
|----------|--------|-------------|
| Code-first (Browse.ts CLI) | ~50-200 per op | Direct Playwright API |
| **Result** | **Minimal token cost** | Fastest execution |

## Quick Start

```bash
# Install dependencies
cd ~/.claude/skills/Browser
bun install

# Take a screenshot
bun examples/screenshot.ts https://example.com

# Verify a page loads
bun examples/verify-page.ts https://example.com
```

## Usage

### Basic

```typescript
import { PlaywrightBrowser } from '~/.claude/skills/Development/Browser/index.ts'

const browser = new PlaywrightBrowser()
await browser.launch()
await browser.navigate('https://example.com')
await browser.screenshot({ path: 'screenshot.png' })
await browser.close()
```

### Form Interaction

```typescript
const browser = new PlaywrightBrowser()
await browser.launch({ headless: false }) // Watch it work

await browser.navigate('https://example.com/login')
await browser.fill('#email', 'test@example.com')
await browser.fill('#password', 'secret')
await browser.click('button[type="submit"]')
await browser.waitForNavigation()

const title = await browser.getTitle()
console.log(`Logged in! Page: ${title}`)

await browser.close()
```

### Page Verification

```typescript
const browser = new PlaywrightBrowser()
await browser.launch()

await browser.navigate('https://example.com')

// Check specific element exists
await browser.waitForSelector('h1')
const heading = await browser.getVisibleText('h1')
console.log(`Found heading: ${heading}`)

// Check for console errors
const errors = browser.getConsoleLogs({ type: 'error' })
if (errors.length > 0) {
  console.log('Console errors:', errors)
}

// Get accessibility tree (like MCP uses)
const a11yTree = await browser.getAccessibilityTree()

await browser.close()
```

### Device Emulation

```typescript
const browser = new PlaywrightBrowser()
await browser.launch()

// Emulate iPhone
await browser.setDevice('iPhone 14')
await browser.navigate('https://example.com')
await browser.screenshot({ path: 'mobile.png' })

// Or set custom viewport
await browser.resize(375, 812)

await browser.close()
```

## API Reference

### Constructor

```typescript
const browser = new PlaywrightBrowser()
```

### Launch Options

```typescript
await browser.launch({
  browser: 'chromium', // 'chromium' | 'firefox' | 'webkit'
  headless: true,      // false to see browser
  viewport: { width: 1280, height: 720 },
  userAgent: 'Custom UA'
})
```

### Navigation

| Method | Description |
|--------|-------------|
| `navigate(url, options?)` | Go to URL |
| `goBack()` | Browser back |
| `goForward()` | Browser forward |
| `reload()` | Refresh page |
| `getUrl()` | Current URL |
| `getTitle()` | Page title |

### Capture

| Method | Description |
|--------|-------------|
| `screenshot(options?)` | Take screenshot |
| `getVisibleText(selector?)` | Extract text |
| `getVisibleHtml(options?)` | Get HTML |
| `savePdf(path, options?)` | Export PDF |
| `getAccessibilityTree()` | A11y snapshot |

### Interaction

| Method | Description |
|--------|-------------|
| `click(selector)` | Click element |
| `hover(selector)` | Mouse hover |
| `fill(selector, value)` | Fill input |
| `type(selector, text, delay?)` | Type with delay |
| `select(selector, value)` | Select dropdown |
| `pressKey(key, selector?)` | Keyboard |
| `drag(source, target)` | Drag and drop |
| `uploadFile(selector, path)` | File upload |

### Waiting

| Method | Description |
|--------|-------------|
| `waitForSelector(selector)` | Wait for element |
| `waitForNavigation()` | Wait for page |
| `waitForNetworkIdle()` | Wait for idle |
| `wait(ms)` | Fixed delay |

### JavaScript

| Method | Description |
|--------|-------------|
| `evaluate(script)` | Run JS |
| `getConsoleLogs()` | Console output |
| `setUserAgent(ua)` | Change UA |

### iFrame

| Method | Description |
|--------|-------------|
| `iframeClick(iframe, el)` | Click in iframe |
| `iframeFill(iframe, el, val)` | Fill in iframe |

## Token Efficiency

Browse.ts CLI provides direct Playwright code execution:

1. **Zero startup cost** - No tokens until you use a function
2. **~50-200 tokens per operation** - Just the code you execute
3. **Full Playwright API** - Complete access to all Playwright capabilities

### Usage

```typescript
// Import and use directly - no MCP server needed
import { PlaywrightBrowser } from '~/.claude/skills/Development/Browser/index.ts'

const browser = new PlaywrightBrowser()
// ... use it
```

## Requirements

- Bun runtime
- Playwright (`bun add playwright`)

## Related

- [Playwright Docs](https://playwright.dev)
- [Browse.ts CLI](Tools/Browse.ts)
- [BrowserSession.ts Server](Tools/BrowserSession.ts)
