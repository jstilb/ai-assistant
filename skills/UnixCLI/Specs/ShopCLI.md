# Shop CLI Factory - Full System Spec

## Overview

A dynamic CLI system that can learn and interact with any online shop. Point at a URL, AI discovers the structure, and you get a working CLI immediately.

```bash
# Discovery
kaya-cli shop discover https://rei.com
kaya-cli shop discover "Best Buy"  # AI finds URL

# Usage (after discovery)
kaya-cli shop rei search "hiking boots"
kaya-cli shop rei details <product-id>
kaya-cli shop rei price <product-url>
kaya-cli shop rei add-to-cart <product-url>
kaya-cli shop rei cart
kaya-cli shop rei watch <product-url> --below $50
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         kaya-cli shop                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Discovery  │───▶│   ShopSpec   │───▶│   ShopCLI    │      │
│  │    Engine    │    │    Store     │    │   Runtime    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Playwright  │    │ ~/.claude/   │    │   Browser    │      │
│  │  + LLM       │    │ shops/*.json │    │   Session    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                 │               │
│                                                 ▼               │
│                                          ┌──────────────┐      │
│                                          │Price Watcher │      │
│                                          │  (launchd)   │      │
│                                          └──────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. ShopSpec Schema

The learned structure of a shop, stored as JSON:

```typescript
interface ShopSpec {
  // Identity
  name: string;                    // "rei", "bestbuy", "amazon"
  displayName: string;             // "REI", "Best Buy", "Amazon"
  baseUrl: string;                 // "https://www.rei.com"
  discoveredAt: string;            // ISO timestamp
  lastVerified: string;            // ISO timestamp
  confidence: number;              // 0-1, how reliable the spec is

  // Selectors (CSS or XPath)
  selectors: {
    // Search
    searchInput: string;
    searchButton?: string;
    searchResults: string;

    // Product listing
    productCard: string;
    productName: string;
    productPrice: string;
    productImage?: string;
    productLink: string;

    // Product detail page
    detailName: string;
    detailPrice: string;
    detailDescription?: string;
    detailImages?: string;
    detailSpecs?: string;
    addToCartButton: string;

    // Cart
    cartIcon?: string;
    cartCount?: string;
    cartItems?: string;
    cartTotal?: string;

    // Pagination
    nextPage?: string;
    pageNumber?: string;
  };

  // URL patterns
  patterns: {
    search: string;               // "/search?q={query}"
    product: RegExp | string;     // "/product/([a-z0-9-]+)"
    cart: string;                 // "/cart"
    category?: string;            // "/c/{category}"
  };

  // Authentication
  auth: {
    type: "none" | "cookie" | "login";
    sessionPath?: string;         // Where to store session
    loginUrl?: string;
    loginSelectors?: {
      username: string;
      password: string;
      submit: string;
    };
  };

  // Behavior hints
  behavior: {
    requiresJS: boolean;          // Needs full browser vs fetch
    hasInfiniteScroll: boolean;
    antiBot: "none" | "low" | "medium" | "high";
    rateLimit?: number;           // ms between requests
  };

  // Extracted metadata
  metadata: {
    categories?: string[];
    priceFormat?: string;         // "$1,234.56" pattern
    currency?: string;
  };
}
```

**Storage:** `~/.claude/tools/UnixCLI/shops/<name>.json`

---

### 2. Discovery Engine

**File:** `tools/UnixCLI/ShopDiscovery.ts`

```typescript
interface DiscoveryOptions {
  url: string;
  name?: string;              // Override auto-detected name
  sampleSearch?: string;      // Query to test search
  interactive?: boolean;      // Ask for confirmation
}

interface DiscoveryResult {
  spec: ShopSpec;
  confidence: number;
  warnings: string[];
  suggestions: string[];
}
```

**Discovery Flow:**

1. **Navigate** to homepage
2. **Screenshot** full page + get DOM snapshot
3. **LLM Analysis** (prompt below)
4. **Validate** by performing test search
5. **Verify** product detail page extraction
6. **Store** spec if confidence > 0.7
7. **Report** results

**LLM Prompt for Discovery:**

```
You are analyzing an e-commerce website to extract its structure.

Given this screenshot and DOM snapshot of {url}:
[screenshot]
[DOM snippet]

Identify these elements and return CSS selectors:

1. SEARCH
   - Search input field
   - Search submit button (if separate)

2. PRODUCT LISTING (on search results page)
   - Product card container
   - Product name within card
   - Product price within card
   - Product link within card

3. PRODUCT DETAIL (on product page)
   - Product name
   - Product price
   - Add to cart button
   - Product description

4. CART
   - Cart icon/link
   - Cart item count badge

5. URL PATTERNS
   - Search URL pattern (e.g., /search?q={query})
   - Product URL pattern (e.g., /product/{id})

Return as JSON matching ShopSpec schema.
Include confidence score (0-1) for each selector.
```

---

### 3. Shop CLI Runtime

**File:** `tools/UnixCLI/ShopCLI.ts`

**Commands:**

| Command | Description | Example |
|---------|-------------|---------|
| `discover` | Learn a new shop | `shop discover https://rei.com` |
| `list` | List known shops | `shop list` |
| `search` | Search products | `shop rei search "tent"` |
| `details` | Get product info | `shop rei details <url>` |
| `price` | Get current price | `shop rei price <url>` |
| `add-to-cart` | Add to cart | `shop rei add-to-cart <url>` |
| `cart` | View cart | `shop rei cart` |
| `watch` | Monitor price | `shop rei watch <url> --below 50` |
| `login` | Authenticate | `shop rei login` |
| `verify` | Re-verify spec | `shop rei verify` |

**Output Formats:**

```bash
# Human readable (default)
kaya-cli shop rei search "hiking boots"

# JSON for piping
kaya-cli shop rei search "hiking boots" --json | jq '.[].price'

# Minimal (just prices)
kaya-cli shop rei price <url> --quiet
```

---

### 4. Browser Session Manager

**File:** `tools/UnixCLI/ShopSession.ts`

Manages persistent browser sessions for authenticated shopping:

```typescript
interface SessionManager {
  // Get or create session for shop
  getSession(shopName: string): Promise<BrowserContext>;

  // Save session state (cookies, localStorage)
  saveSession(shopName: string): Promise<void>;

  // Clear session
  clearSession(shopName: string): Promise<void>;

  // Check if session is valid
  isAuthenticated(shopName: string): Promise<boolean>;
}
```

**Storage:** `~/.claude/sessions/<shop>/`
- `cookies.json`
- `localStorage.json`
- `sessionStorage.json`

---

### 5. Price Watcher

**File:** `tools/UnixCLI/PriceWatcher.ts`

Background monitoring with notifications:

```typescript
interface WatchConfig {
  shopName: string;
  productUrl: string;
  condition: {
    type: "below" | "above" | "change";
    value?: number;
    percent?: number;
  };
  notify: {
    voice?: boolean;
    push?: boolean;
    email?: string;
  };
  frequency: "hourly" | "daily" | "realtime";
}
```

**Storage:** `~/.claude/tools/UnixCLI/watches.json`

**Daemon:** `launchd` job that runs price checks on schedule

```bash
# Add watch
kaya-cli shop rei watch https://rei.com/product/123 --below 50 --notify voice

# List watches
kaya-cli shop watches

# Remove watch
kaya-cli shop unwatch <id>
```

---

### 6. LLM Extractor

**File:** `tools/UnixCLI/ShopExtractor.ts`

Fallback for when selectors fail or for unknown page layouts:

```typescript
interface ExtractRequest {
  url: string;
  extractType: "products" | "product_detail" | "cart" | "price";
  screenshot: Buffer;
  html: string;
}

interface ExtractResult {
  data: any;
  confidence: number;
  usedFallback: boolean;
}
```

**Strategy:**
1. Try CSS selectors from ShopSpec
2. If fail, use LLM to extract from screenshot + DOM
3. If extraction differs from spec, flag for spec update

---

## File Structure

```
~/.claude/
├── tools/UnixCLI/
│   ├── ShopCLI.ts           # Main CLI entry point
│   ├── ShopDiscovery.ts     # Discovery engine
│   ├── ShopSession.ts       # Session management
│   ├── ShopExtractor.ts     # LLM extraction fallback
│   ├── PriceWatcher.ts      # Background monitoring
│   ├── shops/               # Learned shop specs
│   │   ├── rei.json
│   │   ├── bestbuy.json
│   │   └── amazon.json
│   └── watches.json         # Active price watches
├── sessions/                # Browser sessions
│   ├── rei/
│   ├── bestbuy/
│   └── amazon/
├── bin/
│   └── kaya-cli              # Add 'shop' routing
└── skills/UnixCLI/
    └── Workflows/
        └── Shop.md          # Documentation
```

---

## Implementation Phases

### Phase 1: Core CLI + Manual Specs
**Scope:** Build the CLI framework, create specs manually for 3 sites

1. Create `ShopCLI.ts` with command routing
2. Create `ShopSpec` schema and validation
3. Manually create specs for: REI, Best Buy, Target
4. Implement `search`, `details`, `price` commands
5. Add `shop` routing to `kaya-cli`

**Deliverables:**
- Working CLI for 3 sites
- Spec schema finalized
- Basic search/price functionality

### Phase 2: AI Discovery
**Scope:** Automatic spec generation from URLs

1. Create `ShopDiscovery.ts`
2. Integrate Playwright for page capture
3. Design LLM prompts for element detection
4. Implement validation flow
5. Add `discover` command

**Deliverables:**
- `kaya-cli shop discover <url>` works
- Auto-generated specs with 70%+ accuracy
- Interactive refinement flow

### Phase 3: Sessions & Cart
**Scope:** Authenticated shopping, cart management

1. Create `ShopSession.ts`
2. Implement `login`, `add-to-cart`, `cart` commands
3. Handle session persistence
4. Add checkout flow (view only, no auto-purchase)

**Deliverables:**
- Persistent login sessions
- Cart viewing across shops
- Add-to-cart functionality

### Phase 4: Price Watching
**Scope:** Background monitoring with notifications

1. Create `PriceWatcher.ts`
2. Create launchd job for scheduled checks
3. Integrate with Kaya notification system
4. Add `watch`, `watches`, `unwatch` commands

**Deliverables:**
- Background price monitoring
- Voice/push notifications on triggers
- Watch management CLI

---

## Example Usage Flows

### New Shop Discovery
```bash
$ kaya-cli shop discover https://backcountry.com

Discovering backcountry.com...
✓ Navigated to homepage
✓ Found search input: input[name="q"]
✓ Found product cards: .product-tile
✓ Found add-to-cart: button.add-to-cart

Testing with sample search "jacket"...
✓ Search works, found 48 products
✓ Product detail extraction works

Shop spec saved: ~/.claude/tools/UnixCLI/shops/backcountry.json
Confidence: 0.92

You can now use:
  kaya-cli shop backcountry search "jacket"
  kaya-cli shop backcountry price <url>
```

### Price Monitoring
```bash
$ kaya-cli shop rei watch https://rei.com/product/123456 --below 199 --notify voice

Watching: Osprey Atmos AG 65 Pack
Current price: $249.95
Alert when: below $199.00
Check frequency: daily
Notification: voice

Watch ID: w_abc123
To cancel: kaya-cli shop unwatch w_abc123

# Later...
🗣️ "The Osprey pack dropped to $189! 24% off at REI."
```

### Cross-Shop Search (Future)
```bash
$ kaya-cli shop search "sony wh-1000xm5" --compare

Searching across 5 shops...

Amazon:        $328.00  ✓ In stock
Best Buy:      $349.99  ✓ In stock
Target:        $349.99  ✓ In stock
Walmart:       $328.00  ⚠ Low stock
Costco:        $299.99  ✓ Members only

Lowest: Costco ($299.99) - membership required
Best available: Amazon/Walmart ($328.00)
```

---

## Security Considerations

1. **Credentials:** Store in `secrets.json`, never in spec files
2. **Sessions:** Encrypt at rest, auto-expire after 7 days
3. **Rate limiting:** Respect site limits, random delays
4. **Cart actions:** Require confirmation for checkout
5. **Anti-bot:** Detect and warn, don't circumvent aggressively

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `playwright` | Browser automation |
| `@anthropic-ai/sdk` | LLM extraction (via Kaya inference) |
| `zod` | Schema validation |
| `node-cron` | Price watch scheduling |

---

## Success Criteria

1. **Discovery:** 70%+ of major US retailers work with auto-discovery
2. **Accuracy:** Price extraction accurate to $0.01
3. **Speed:** Search results in <5 seconds
4. **Reliability:** 95%+ success rate for known shops
5. **Maintenance:** Specs auto-update when sites change

---

## Open Questions

1. **Checkout:** Should we support one-click purchase, or stop at cart?
2. **Accounts:** Create new accounts or only use existing?
3. **Captchas:** How to handle bot detection? Manual fallback?
4. **Legal:** Terms of service considerations per site?

---

## Next Steps

When ready to build:
1. Start with Phase 1 (Core CLI + Manual Specs)
2. Create specs for 3 shops manually
3. Validate the schema works well
4. Then move to Phase 2 for AI discovery
