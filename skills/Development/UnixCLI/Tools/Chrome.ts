#!/usr/bin/env bun
/**
 * Chrome CLI - Unix-style interface for Chrome browser via chrome-cli
 *
 * Usage:
 *   kaya-cli chrome tabs              - List all open tabs
 *   kaya-cli chrome windows           - List all windows
 *   kaya-cli chrome info [tab-id]     - Tab details (active tab if no id)
 *   kaya-cli chrome open <url>        - Open URL in new tab
 *   kaya-cli chrome close [tab-id]    - Close tab
 *   kaya-cli chrome activate <tab-id> - Switch to tab
 *   kaya-cli chrome reload [tab-id]   - Reload tab
 *   kaya-cli chrome read [tab-id]     - Extract clean text from tab
 *   kaya-cli chrome execute '<js>'    - Run JS in tab
 *   kaya-cli chrome search <query>    - Fuzzy-match tabs
 *   kaya-cli chrome summarize [target]- Summarize tab(s) via AI
 *   kaya-cli chrome collect           - Read all tabs as structured JSON
 *   kaya-cli chrome status            - Check prerequisites
 *
 * Requires: brew install chrome-cli
 * For read/execute/summarize: Chrome > View > Developer > Allow JavaScript from Apple Events
 */

import { maybeEncode } from '../../../../lib/core/ToonHelper';
import { inference, type InferenceLevel } from '../../../../lib/core/Inference';

const COLORS = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  dim: '\x1b[2m',
  nc: '\x1b[0m',
};

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class AppleEventsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleEventsError';
  }
}

class ChromeNotRunningError extends Error {
  constructor() {
    super('Google Chrome is not running');
    this.name = 'ChromeNotRunningError';
  }
}

class TabNotFoundError extends Error {
  constructor(tabId: string) {
    super(`Tab not found: ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// chrome-cli subprocess helper
// ---------------------------------------------------------------------------

function chromeCLI(args: string[], env?: Record<string, string>): string {
  const result = Bun.spawnSync(['chrome-cli', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });

  const stderr = new TextDecoder().decode(result.stderr).trim();

  if (result.exitCode !== 0 || stderr) {
    const lower = stderr.toLowerCase();

    if (lower.includes('apple events') || lower.includes('not allowed') || lower.includes('osascript')) {
      throw new AppleEventsError(
        `Apple Events not enabled. Enable in Chrome: View > Developer > Allow JavaScript from Apple Events\n${stderr}`
      );
    }
    if (lower.includes('not running') || lower.includes('connection') || lower.includes('unable to connect')) {
      throw new ChromeNotRunningError();
    }
    if (lower.includes('not found') || lower.includes('invalid tab')) {
      const tabMatch = args.find(a => /^\d+$/.test(a));
      throw new TabNotFoundError(tabMatch ?? 'unknown');
    }
    if (stderr && result.exitCode !== 0) {
      throw new Error(`chrome-cli error: ${stderr}`);
    }
  }

  return new TextDecoder().decode(result.stdout).trim();
}

function isChromeCLIInstalled(): boolean {
  const result = Bun.spawnSync(['which', 'chrome-cli'], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0;
}

/**
 * Execute JavaScript in a Chrome tab and capture the return value.
 * chrome-cli execute doesn't return output, so we use osascript directly.
 */
function executeJS(js: string, tabId?: string): string {
  // Build AppleScript that runs JS in Chrome and returns the result
  const tabRef = tabId
    ? `tab id ${tabId} of window 1`
    : 'active tab of front window';

  const script = `tell application "Google Chrome" to execute ${tabRef} javascript ${JSON.stringify(js)}`;

  const result = Bun.spawnSync(['osascript', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderr = new TextDecoder().decode(result.stderr).trim();

  if (result.exitCode !== 0 || stderr) {
    const lower = stderr.toLowerCase();
    if (lower.includes('not allowed') || lower.includes('apple events') || lower.includes('1743')) {
      throw new AppleEventsError(
        'Apple Events not enabled. Enable in Chrome: View > Developer > Allow JavaScript from Apple Events'
      );
    }
    if (stderr && result.exitCode !== 0) {
      throw new Error(`JavaScript execution error: ${stderr}`);
    }
  }

  return new TextDecoder().decode(result.stdout).trim();
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface TabInfo {
  id: number;
  title: string;
  url: string;
  windowId?: number;
  loading?: boolean;
}

interface WindowInfo {
  id: number;
  name: string;
  tabs?: number;
}

function parseIdLines(raw: string): Array<{ id: number; text: string }> {
  // chrome-cli outputs lines like: [554501844] Some text
  const entries: Array<{ id: number; text: string }> = [];
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^\[(\d+)\]\s+(.+)/);
    if (match) {
      entries.push({ id: parseInt(match[1], 10), text: match[2].trim() });
    }
  }
  return entries;
}

function parseTabsList(): TabInfo[] {
  // chrome-cli list tabs: [id] Title
  // chrome-cli list links: [id] URL  (same IDs, matching order)
  const tabsRaw = chromeCLI(['list', 'tabs']);
  const linksRaw = chromeCLI(['list', 'links']);

  const tabEntries = parseIdLines(tabsRaw);
  const linkEntries = parseIdLines(linksRaw);
  const urlMap = new Map(linkEntries.map(l => [l.id, l.text]));

  return tabEntries.map(t => ({
    id: t.id,
    title: t.text,
    url: urlMap.get(t.id) ?? '',
  }));
}

function parseWindowsList(raw: string): WindowInfo[] {
  const windows: WindowInfo[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^\[(\d+)\]\s+(.+)/);
    if (match) {
      windows.push({
        id: parseInt(match[1], 10),
        name: match[2].trim(),
      });
    }
  }

  return windows;
}

function parseTabInfo(raw: string): Partial<TabInfo> & { loading?: boolean } {
  const info: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\w[\w\s]*?):\s+(.+)/);
    if (match) {
      info[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }

  return {
    id: info['id'] ? parseInt(info['id'], 10) : undefined,
    title: info['title'] ?? '',
    url: info['url'] ?? '',
    loading: info['loading'] === 'Yes',
  };
}

// ---------------------------------------------------------------------------
// Text extraction JS
// ---------------------------------------------------------------------------

const EXTRACT_TEXT_JS = `(function() {
  var clone = document.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,link,meta,nav,header,footer,[role="banner"],[role="navigation"],[role="complementary"],aside,.sidebar,.ad,.advertisement')
    .forEach(function(el) { el.remove(); });
  var text = (clone.body || clone.documentElement).innerText || '';
  return text.replace(/<[^>]*>/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;

// ---------------------------------------------------------------------------
// Fuzzy search
// ---------------------------------------------------------------------------

function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(n)) return 100;
  if (h === n) return 200;

  let score = 0;
  let lastIdx = -1;
  for (const ch of n) {
    const idx = h.indexOf(ch, lastIdx + 1);
    if (idx === -1) return 0;
    score += 1;
    if (idx === lastIdx + 1) score += 2; // consecutive bonus
    lastIdx = idx;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  positional: string[];
  json: boolean;
  toon: boolean;
  html: boolean;
  level: InferenceLevel;
  query: string;
  tabId: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: '',
    positional: [],
    json: false,
    toon: false,
    html: false,
    level: 'fast',
    query: '',
    tabId: '',
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--toon') {
      result.toon = true;
    } else if (arg === '--html') {
      result.html = true;
    } else if (arg === '--level' && argv[i + 1]) {
      const lvl = argv[i + 1].toLowerCase();
      if (['fast', 'standard', 'smart'].includes(lvl)) {
        result.level = lvl as InferenceLevel;
      }
      i++;
    } else if (arg === '--query' && argv[i + 1]) {
      result.query = argv[i + 1];
      i++;
    } else if (arg === '-t' && argv[i + 1]) {
      result.tabId = argv[i + 1];
      i++;
    } else if (!arg.startsWith('-')) {
      result.positional.push(arg);
    }
    i++;
  }

  result.command = result.positional.shift() ?? '';

  // First positional after command may be a tab-id or subcommand arg
  if (result.positional.length > 0 && !result.tabId) {
    // Check if it looks like a tab-id (numeric)
    if (/^\d+$/.test(result.positional[0]) && !['open', 'search', 'execute'].includes(result.command)) {
      result.tabId = result.positional.shift()!;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdStatus(args: ParsedArgs): void {
  const installed = isChromeCLIInstalled();
  let version = '';
  let chromeRunning = false;
  let tabCount = 0;
  let windowCount = 0;
  let appleEventsOk = false;

  if (installed) {
    try {
      version = chromeCLI(['version']);
    } catch { /* not running */ }

    try {
      const tabsRaw = chromeCLI(['list', 'tabs']);
      chromeRunning = true;
      tabCount = parseIdLines(tabsRaw).length;
    } catch (e) {
      if (e instanceof ChromeNotRunningError) {
        chromeRunning = false;
      }
    }

    try {
      const windowsRaw = chromeCLI(['list', 'windows']);
      windowCount = parseWindowsList(windowsRaw).length;
    } catch { /* ignore */ }

    if (chromeRunning) {
      try {
        executeJS('1+1');
        appleEventsOk = true;
      } catch (e) {
        if (e instanceof AppleEventsError) {
          appleEventsOk = false;
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      chromeCli: { installed, version },
      chrome: { running: chromeRunning, tabs: tabCount, windows: windowCount },
      appleEvents: appleEventsOk,
    }, null, 2));
    return;
  }

  console.log(`${COLORS.cyan}Chrome CLI Status${COLORS.nc}\n`);
  console.log(`  chrome-cli:    ${installed ? `${COLORS.green}installed${COLORS.nc} (${version})` : `${COLORS.red}not installed${COLORS.nc} — brew install chrome-cli`}`);
  console.log(`  Chrome:        ${chromeRunning ? `${COLORS.green}running${COLORS.nc}` : `${COLORS.red}not running${COLORS.nc}`}`);
  if (chromeRunning) {
    console.log(`  Tabs:          ${tabCount}`);
    console.log(`  Windows:       ${windowCount}`);
    console.log(`  Apple Events:  ${appleEventsOk ? `${COLORS.green}enabled${COLORS.nc}` : `${COLORS.yellow}disabled${COLORS.nc} — View > Developer > Allow JavaScript from Apple Events`}`);
  }
}

function cmdTabs(args: ParsedArgs): void {
  const tabs = parseTabsList();

  if (args.toon) {
    const result = maybeEncode(tabs);
    console.log(result.data);
  } else if (args.json) {
    console.log(JSON.stringify(tabs, null, 2));
  } else {
    console.log(`${COLORS.cyan}Open Tabs (${tabs.length}):${COLORS.nc}\n`);
    for (const tab of tabs) {
      const shortUrl = tab.url.length > 60 ? tab.url.slice(0, 57) + '...' : tab.url;
      console.log(`  ${COLORS.green}[${tab.id}]${COLORS.nc} ${tab.title}`);
      console.log(`       ${COLORS.dim}${shortUrl}${COLORS.nc}`);
    }
  }
}

function cmdWindows(args: ParsedArgs): void {
  const raw = chromeCLI(['list', 'windows']);
  const windows = parseWindowsList(raw);

  if (args.json) {
    console.log(JSON.stringify(windows, null, 2));
  } else {
    console.log(`${COLORS.cyan}Windows (${windows.length}):${COLORS.nc}\n`);
    for (const w of windows) {
      console.log(`  ${COLORS.green}[${w.id}]${COLORS.nc} ${w.name}`);
    }
  }
}

function cmdInfo(args: ParsedArgs): void {
  const cliArgs = args.tabId ? ['info', '-t', args.tabId] : ['info'];
  const raw = chromeCLI(cliArgs);
  const info = parseTabInfo(raw);

  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`${COLORS.cyan}Tab Info${COLORS.nc}\n`);
    if (info.id) console.log(`  ${COLORS.blue}ID:${COLORS.nc}      ${info.id}`);
    if (info.title) console.log(`  ${COLORS.blue}Title:${COLORS.nc}   ${info.title}`);
    if (info.url) console.log(`  ${COLORS.blue}URL:${COLORS.nc}     ${info.url}`);
    if (info.loading !== undefined) console.log(`  ${COLORS.blue}Loading:${COLORS.nc} ${info.loading ? 'Yes' : 'No'}`);
  }
}

function cmdOpen(args: ParsedArgs): void {
  const url = args.positional[0];
  if (!url) {
    console.error(`${COLORS.red}Error:${COLORS.nc} URL required`);
    console.error('Usage: kaya-cli chrome open <url>');
    process.exit(1);
  }
  const raw = chromeCLI(['open', url]);
  if (args.json) {
    console.log(JSON.stringify({ opened: url, result: raw }));
  } else {
    console.log(`${COLORS.green}Opened:${COLORS.nc} ${url}`);
  }
}

function cmdClose(args: ParsedArgs): void {
  const cliArgs = args.tabId ? ['close', '-t', args.tabId] : ['close'];
  chromeCLI(cliArgs);
  if (args.json) {
    console.log(JSON.stringify({ closed: args.tabId || 'active' }));
  } else {
    console.log(`${COLORS.green}Closed${COLORS.nc} tab ${args.tabId || '(active)'}`);
  }
}

function cmdActivate(args: ParsedArgs): void {
  const tabId = args.tabId || args.positional[0];
  if (!tabId) {
    console.error(`${COLORS.red}Error:${COLORS.nc} Tab ID required`);
    console.error('Usage: kaya-cli chrome activate <tab-id>');
    process.exit(1);
  }
  chromeCLI(['activate', '-t', tabId]);
  if (args.json) {
    console.log(JSON.stringify({ activated: tabId }));
  } else {
    console.log(`${COLORS.green}Activated${COLORS.nc} tab ${tabId}`);
  }
}

function cmdReload(args: ParsedArgs): void {
  const cliArgs = args.tabId ? ['reload', '-t', args.tabId] : ['reload'];
  chromeCLI(cliArgs);
  if (args.json) {
    console.log(JSON.stringify({ reloaded: args.tabId || 'active' }));
  } else {
    console.log(`${COLORS.green}Reloaded${COLORS.nc} tab ${args.tabId || '(active)'}`);
  }
}

function cmdRead(args: ParsedArgs): void {
  if (args.html) {
    // Raw HTML source
    const cliArgs = args.tabId ? ['source', '-t', args.tabId] : ['source'];
    const html = chromeCLI(cliArgs);
    if (args.json) {
      // Get info for metadata
      const infoArgs = args.tabId ? ['info', '-t', args.tabId] : ['info'];
      const info = parseTabInfo(chromeCLI(infoArgs));
      console.log(JSON.stringify({ title: info.title, url: info.url, html }));
    } else {
      console.log(html);
    }
    return;
  }

  // Clean text via JS execution
  const text = executeJS(EXTRACT_TEXT_JS, args.tabId || undefined);

  if (args.json) {
    const infoArgs = args.tabId ? ['info', '-t', args.tabId] : ['info'];
    const info = parseTabInfo(chromeCLI(infoArgs));
    console.log(JSON.stringify({ title: info.title, url: info.url, text }, null, 2));
  } else {
    console.log(text);
  }
}

function cmdExecute(args: ParsedArgs): void {
  // The JS expression is the remaining positional args joined
  const js = args.positional.join(' ');
  if (!js) {
    console.error(`${COLORS.red}Error:${COLORS.nc} JavaScript expression required`);
    console.error("Usage: kaya-cli chrome execute 'document.title'");
    process.exit(1);
  }

  const wrappedJs = args.json ? `JSON.stringify(${js})` : js;
  const result = executeJS(wrappedJs, args.tabId || undefined);
  console.log(result);
}

function cmdSearch(args: ParsedArgs): void {
  const query = args.positional.join(' ') || args.query;
  if (!query) {
    console.error(`${COLORS.red}Error:${COLORS.nc} Search query required`);
    console.error('Usage: kaya-cli chrome search <query>');
    process.exit(1);
  }

  const tabs = parseTabsList();

  const scored = tabs
    .map(tab => ({
      ...tab,
      score: Math.max(
        fuzzyScore(query, tab.title),
        fuzzyScore(query, tab.url)
      ),
    }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score);

  if (args.toon) {
    const result = maybeEncode(scored);
    console.log(result.data);
  } else if (args.json) {
    console.log(JSON.stringify(scored, null, 2));
  } else {
    if (scored.length === 0) {
      console.log(`${COLORS.yellow}No tabs matching "${query}"${COLORS.nc}`);
      return;
    }
    console.log(`${COLORS.cyan}Tabs matching "${query}" (${scored.length}):${COLORS.nc}\n`);
    for (const tab of scored) {
      const shortUrl = tab.url.length > 60 ? tab.url.slice(0, 57) + '...' : tab.url;
      console.log(`  ${COLORS.green}[${tab.id}]${COLORS.nc} ${tab.title} ${COLORS.dim}(score: ${tab.score})${COLORS.nc}`);
      console.log(`       ${COLORS.dim}${shortUrl}${COLORS.nc}`);
    }
  }
}

async function cmdSummarize(args: ParsedArgs): Promise<void> {
  const target = args.positional[0]; // undefined = active tab, 'all', or a search query

  interface TabSummary {
    id: number;
    title: string;
    url: string;
    summary: string;
  }

  async function summarizeTab(tabId?: string): Promise<TabSummary> {
    const infoArgs = tabId ? ['info', '-t', tabId] : ['info'];
    const info = parseTabInfo(chromeCLI(infoArgs));

    const text = executeJS(EXTRACT_TEXT_JS, tabId);

    const result = await inference({
      level: args.level,
      systemPrompt: 'Summarize this web page in 2-4 concise sentences. Focus on the main content and purpose.',
      userPrompt: `Title: ${info.title}\nURL: ${info.url}\n\n${text.slice(0, 8000)}`,
    });

    return {
      id: info.id ?? 0,
      title: info.title ?? '',
      url: info.url ?? '',
      summary: result.success ? result.output : `Error: ${result.error}`,
    };
  }

  if (!target || /^\d+$/.test(target)) {
    // Single tab
    const tabId = target || args.tabId;
    const result = await summarizeTab(tabId || undefined);

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${COLORS.cyan}${result.title}${COLORS.nc}`);
      console.log(`${COLORS.dim}${result.url}${COLORS.nc}\n`);
      console.log(result.summary);
    }
    return;
  }

  // Multiple tabs: 'all' or search query
  let tabs = parseTabsList();

  if (target !== 'all') {
    // Filter by search query
    tabs = tabs.filter(t =>
      fuzzyScore(target, t.title) > 0 || fuzzyScore(target, t.url) > 0
    );
  }

  if (tabs.length === 0) {
    console.log(`${COLORS.yellow}No matching tabs found${COLORS.nc}`);
    return;
  }

  if (!args.json) {
    console.log(`${COLORS.cyan}Summarizing ${tabs.length} tab(s)...${COLORS.nc}\n`);
  }

  const summaries: TabSummary[] = [];
  for (const tab of tabs) {
    try {
      const result = await summarizeTab(String(tab.id));
      summaries.push(result);
      if (!args.json) {
        console.log(`${COLORS.green}[${tab.id}]${COLORS.nc} ${COLORS.cyan}${result.title}${COLORS.nc}`);
        console.log(`${COLORS.dim}${result.url}${COLORS.nc}`);
        console.log(`${result.summary}\n`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      summaries.push({ id: tab.id, title: tab.title, url: tab.url, summary: `Error: ${msg}` });
      if (!args.json) {
        console.log(`${COLORS.red}[${tab.id}]${COLORS.nc} ${tab.title}: Error - ${msg}\n`);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(summaries, null, 2));
  }
}

function cmdCollect(args: ParsedArgs): void {
  let tabs = parseTabsList();

  // Apply query filter
  const query = args.query || args.positional[0];
  if (query) {
    tabs = tabs.filter(t =>
      fuzzyScore(query, t.title) > 0 || fuzzyScore(query, t.url) > 0
    );
  }

  interface CollectedTab {
    id: number;
    title: string;
    url: string;
    text: string;
  }

  const collected: CollectedTab[] = [];
  const errors: Array<{ id: number; title: string; error: string }> = [];

  for (const tab of tabs) {
    try {
      const text = executeJS(EXTRACT_TEXT_JS, String(tab.id));
      collected.push({ id: tab.id, title: tab.title, url: tab.url, text });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id: tab.id, title: tab.title, error: msg });
    }
  }

  const output = {
    totalTabs: tabs.length,
    collectedTabs: collected.length,
    errors: errors.length,
    filteredTabs: collected,
    ...(errors.length > 0 ? { failedTabs: errors } : {}),
  };

  if (args.toon) {
    const result = maybeEncode(collected);
    console.log(result.data);
  } else if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`${COLORS.cyan}Collected ${collected.length}/${tabs.length} tabs${COLORS.nc}`);
    if (errors.length > 0) {
      console.log(`${COLORS.yellow}${errors.length} tab(s) failed (Apple Events?)${COLORS.nc}`);
    }
    console.log('');
    for (const tab of collected) {
      console.log(`${COLORS.green}[${tab.id}]${COLORS.nc} ${COLORS.cyan}${tab.title}${COLORS.nc}`);
      console.log(`${COLORS.dim}${tab.url}${COLORS.nc}`);
      const preview = tab.text.slice(0, 200).replace(/\n/g, ' ');
      console.log(`${preview}${tab.text.length > 200 ? '...' : ''}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`${COLORS.cyan}kaya-cli chrome${COLORS.nc} - Chrome browser via chrome-cli

${COLORS.blue}Usage:${COLORS.nc}
  kaya-cli chrome <command> [options]

${COLORS.blue}Commands:${COLORS.nc}
  ${COLORS.green}tabs${COLORS.nc}                       List all open tabs
  ${COLORS.green}windows${COLORS.nc}                    List all windows
  ${COLORS.green}info${COLORS.nc} [tab-id]              Tab details (active tab if no id)
  ${COLORS.green}open${COLORS.nc} <url>                 Open URL in new tab
  ${COLORS.green}close${COLORS.nc} [tab-id]             Close tab (active tab if no id)
  ${COLORS.green}activate${COLORS.nc} <tab-id>          Switch to tab
  ${COLORS.green}reload${COLORS.nc} [tab-id]            Reload tab
  ${COLORS.green}read${COLORS.nc} [tab-id]              Extract clean text from tab
  ${COLORS.green}execute${COLORS.nc} '<js>'             Run JavaScript in tab
  ${COLORS.green}search${COLORS.nc} <query>             Fuzzy-match tabs by title/URL
  ${COLORS.green}summarize${COLORS.nc} [tab-id|all|q]   Summarize tab(s) via AI
  ${COLORS.green}collect${COLORS.nc}                    Read all tabs, output structured data
  ${COLORS.green}status${COLORS.nc}                     Check prerequisites
  ${COLORS.green}help${COLORS.nc}                       Show this help

${COLORS.blue}Options:${COLORS.nc}
  --json                        Output as JSON
  --toon                        Output as TOON format
  --html                        Raw HTML (with read)
  --level <fast|standard|smart> AI level for summarize (default: fast)
  --query <filter>              Filter for collect
  -t <tab-id>                   Target tab by ID

${COLORS.blue}Examples:${COLORS.nc}
  kaya-cli chrome tabs --json
  kaya-cli chrome read --json
  kaya-cli chrome read --html | head -20
  kaya-cli chrome execute 'document.title'
  kaya-cli chrome execute 'document.links.length' --json
  kaya-cli chrome search "github"
  kaya-cli chrome summarize --level fast
  kaya-cli chrome summarize all --level fast --json
  kaya-cli chrome collect --query "github" --json

${COLORS.blue}Prerequisites:${COLORS.nc}
  brew install chrome-cli
  Chrome > View > Developer > Allow JavaScript from Apple Events

${COLORS.blue}Pipe composition:${COLORS.nc}
  kaya-cli chrome tabs --json | jq '.[] | select(.url | contains("github"))'
  kaya-cli chrome collect --json | kaya-cli toon encode
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    showHelp();
    process.exit(0);
  }

  // Check chrome-cli is installed for all commands except help
  if (!isChromeCLIInstalled()) {
    console.error(`${COLORS.red}Error:${COLORS.nc} chrome-cli not installed`);
    console.error('Install: brew install chrome-cli');
    process.exit(1);
  }

  try {
    switch (args.command) {
      case 'status': {
        cmdStatus(args);
        break;
      }
      case 'tabs': {
        cmdTabs(args);
        break;
      }
      case 'windows': {
        cmdWindows(args);
        break;
      }
      case 'info': {
        cmdInfo(args);
        break;
      }
      case 'open': {
        cmdOpen(args);
        break;
      }
      case 'close': {
        cmdClose(args);
        break;
      }
      case 'activate': {
        cmdActivate(args);
        break;
      }
      case 'reload': {
        cmdReload(args);
        break;
      }
      case 'read': {
        cmdRead(args);
        break;
      }
      case 'execute': {
        cmdExecute(args);
        break;
      }
      case 'search': {
        cmdSearch(args);
        break;
      }
      case 'summarize': {
        await cmdSummarize(args);
        break;
      }
      case 'collect': {
        cmdCollect(args);
        break;
      }
      default: {
        console.error(`${COLORS.red}Error:${COLORS.nc} Unknown command: ${args.command}`);
        console.error("Run 'kaya-cli chrome help' for usage");
        process.exit(1);
      }
    }
  } catch (error: unknown) {
    if (error instanceof AppleEventsError) {
      console.error(`${COLORS.red}Apple Events Error:${COLORS.nc} ${error.message}`);
      process.exit(1);
    }
    if (error instanceof ChromeNotRunningError) {
      console.error(`${COLORS.red}Error:${COLORS.nc} Google Chrome is not running`);
      process.exit(1);
    }
    if (error instanceof TabNotFoundError) {
      console.error(`${COLORS.red}Error:${COLORS.nc} ${error.message}`);
      process.exit(1);
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${COLORS.red}Error:${COLORS.nc} ${msg}`);
    process.exit(1);
  }
}

main();
