---
name: Instacart
version: 2.0.0
description: Browser-based Instacart automation with stealth, selector resilience, and store matching. USE WHEN groceries, instacart, add to cart, grocery shopping, order food, grocery list, buy groceries, shopping list.
---

# Instacart - Browser Automation for Grocery Shopping

**Add items to your Instacart cart using browser automation with anti-detection, configurable selectors, and fuzzy store matching.**

**USE WHEN:** groceries, instacart, add to cart, grocery shopping, order food, grocery list, buy groceries, shopping list.

Uses saved session cookies for consistency - no login required after initial setup. Features stealth patches, human-like delays, configurable CSS selector fallbacks, CAPTCHA detection, and structured logging.

---

## Customization

Modify these settings to adapt the skill:

| Setting | Default | Description |
|---------|---------|-------------|
| Session file | `~/.instacart-session.json` | Where session cookies are stored |
| Selectors config | `config/selectors.json` | CSS selector priority arrays with fallbacks |
| UA pool | `config/ua-pool.json` | Curated Chrome 130+ user agent strings |
| Known stores | `config/known-stores.json` | Store names for fuzzy matching |
| Log directory | `$KAYA_HOME/MEMORY/LOGS/instacart/` | JSON execution reports and metrics |
| Headless mode | `true` (after login) | Run without visible browser |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `INSTACART_LOG_DIR` | Directory for JSON logs and metrics | `$KAYA_HOME/MEMORY/LOGS/instacart/` |
| `INSTACART_HEADLESS` | Run browser in headless mode | `false` |
| `INSTACART_DELAY_MIN` | Minimum inter-action delay (ms) | `1500` |
| `INSTACART_DELAY_MAX` | Maximum inter-action delay (ms) | `3500` |

### Updating Selectors

When Instacart changes their UI, update `config/selectors.json`. Each entry has a `primary` selector and `fallbacks` array. The selector engine tries primary first with exponential backoff, then iterates fallbacks.

Run `check-selectors` to validate against the live site:
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts check-selectors
```

---

## Voice Notification

Uses `notifySync()` from `skills/CORE/Tools/NotificationService.ts` on every exit path:

| Event | Message Format |
|-------|---------------|
| Success | `Shopping complete. Added N of M items to {store} cart.` |
| Partial success | `Partial success. Added N of M items. K unavailable.` |
| Failure | `Shopping failed. Could not add items to {store} cart.` |
| CAPTCHA | `Shopping interrupted. Instacart requests verification.` |
| Session expired | `Shopping failed. Session expired.` |
| Degradation warning | `Instacart skill maintenance needed: low success rate` |

All notification messages are 100 characters or fewer.

---

## Workflow Routing

| Command | Action | Description |
|---------|--------|-------------|
| `login` | Manual | Open browser for login, save session |
| `add <items>` | Automated | Search and add items to cart |
| `add <items> --store <name>` | Automated | Select store then add items |
| `cart` | Automated | View current cart contents |
| `status` | Automated | Check session validity |
| `logout` | Manual | Clear saved session |
| `check-selectors` | Automated | Validate CSS selectors against live page |

### Quantity Formats (parsed inline)

| Format | Example | Result |
|--------|---------|--------|
| Prefix `Nx` | `3x Eggs` | 3 eggs |
| Suffix `xN` | `Eggs x3` | 3 eggs |
| Number-space | `3 Eggs` | 3 eggs |
| Bare | `Eggs` | 1 egg (default) |

### Store Selection

The `--store` flag accepts fuzzy-matched store names:
- Exact: `--store Safeway`
- Typo: `--store safway` (matches Safeway)
- Unknown: `--store "Fake Store"` (shows top 3 suggestions)

Known stores are listed in `config/known-stores.json`.

---

## Examples

**Example 1: Add a grocery list**
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts add "organic bananas" "3x almond milk" "eggs" "bread"
```

**Example 2: Add with store selection**
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts add "avocados" --qty 4 --store Safeway
```

**Example 3: Inline quantities with mixed formats**
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts add "2x eggs" "milk x3" "5 bananas" "bread"
```

**Example 4: Check cart contents**
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts cart --visible
```

**Example 5: Validate selectors**
```bash
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts check-selectors
```

**Example 6: Agent integration (parse user request)**
```bash
# User says: "Order groceries: 3 bananas, milk, and a dozen eggs from Safeway"
bun run $KAYA_DIR/skills/Instacart/Tools/Instacart.ts add "3 bananas" "milk" "12x eggs" --store Safeway
```

---

## Integration

### Uses
- **Playwright** - Browser automation via system Chrome with stealth patches
- **NotificationService** - Voice notifications on every exit path
- **SelectorEngine** - Config-driven CSS resolution with exponential backoff
- **Store Matcher** - Levenshtein fuzzy matching for store names

### Feeds Into
- **Instacart cart** - Items added ready for manual checkout
- **Execution reports** - JSON logs at `$KAYA_HOME/MEMORY/LOGS/instacart/`
- **Metrics** - `metrics.jsonl` with selector hit rates, success rates, timing

### Architecture
```
skills/Instacart/
  Tools/
    Instacart.ts           # Main entry point (CLI + orchestration)
    selector-engine.ts     # Config-driven selector resolution with fallbacks
    stealth.ts             # Anti-detection patches + UA pool
    item-utils.ts          # Quantity parsing + input sanitization
    store-matcher.ts       # Fuzzy store name matching
    __tests__/             # Unit tests for all extracted modules
  config/
    selectors.json         # CSS selector priority arrays
    ua-pool.json           # Curated Chrome 130+ UA strings
    known-stores.json      # Store names for fuzzy matching
  SKILL.md                 # This file
  package.json
```

### Guardrails
- No checkout or payment processing
- No account creation or login automation
- No CAPTCHA solving
- Browser left open on CAPTCHA for manual intervention
- Maximum 50 items per run
- Human-like delays (1.5-3.5s) between all actions

---

**Last Updated:** 2026-02-10
