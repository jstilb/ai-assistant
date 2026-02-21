# Shopping Skill Enhancement Spec

**Goal:** Accept shopping lists and add items to cart at retailers
**Status:** Implementation Phase 1
**Created:** 2026-01-19
**Based on:** Council Debate (Architect, Engineer, Researcher, Security)

---

## Constitutional Principles (Non-Negotiable)

```
Article X: Checkout Protection Gate

No agent may initiate checkout without:
1. Visual screenshot review presented to user
2. Explicit principal approval ("yes, proceed")
3. Audit log entry in MEMORY/shopping-audit.jsonl

This is HARDCODED, not configurable.
```

---

## Architecture

### Tier Strategy

| Tier | Approach | Stability | Coverage |
|------|----------|-----------|----------|
| **Tier 3** | Curated links | Stable | Universal |
| **Tier 2** | Browser automation | Fragile | Per-retailer |
| **Tier 1** | Retailer APIs | Stable | Limited |

**Build order:** Tier 3 → Tier 2 → Tier 1 (opportunistic)

### Shopping List as Router

```
Shopping List Input
        │
        ▼
┌───────────────────┐
│  LIST ROUTER      │  ← Parses list, routes by retailer
└────────┬──────────┘
         │
    ┌────┼────┬────┐
    ▼    ▼    ▼    ▼
┌────┐ ┌────┐ ┌────┐ ┌────┐
│REI │ │Pata│ │Nord│ │Fall│
│Cart│ │Cart│ │Cart│ │back│
└────┘ └────┘ └────┘ └────┘
    │    │    │    │
    └────┴────┴────┘
              │
              ▼
    ┌───────────────┐
    │ VISUAL REVIEW │  ← Screenshot + confirmation
    └───────────────┘
              │
              ▼
    ┌───────────────┐
    │ HUMAN GATE    │  ← User approves before checkout
    └───────────────┘
```

### Session Isolation

Each retailer gets its own:
- Session file: `~/.pai-shopping/sessions/{retailer}.json`
- Encrypted at rest (system keychain)
- TTL: 24 hours before re-auth prompt

---

## Phase 1: Tier 3 Fallback (Universal)

**Purpose:** Works for ANY retailer, zero credentials needed

### Input Format

```yaml
# Shopping list format
items:
  - name: "Patagonia Better Sweater"
    size: "M"  # From ShoppingProfile
    quantity: 1
    retailer: "patagonia"  # Optional, can be inferred

  - name: "REI Co-op Flash 22 Pack"
    quantity: 1
    retailer: "rei"
```

### Output Format (Tier 3)

```markdown
## Shopping List: Ready to Add

### REI (rei.com)
- [REI Co-op Flash 22 Pack](https://rei.com/search?q=rei+co-op+flash+22+pack) - Size: One Size
  - Note: You have REI gift card + member dividend

### Patagonia (patagonia.com)
- [Better Sweater](https://patagonia.com/search?q=better+sweater) - Size: M

**Click links to add to cart manually, or enable browser automation for automatic cart.**
```

### Implementation

```bash
# Tier 3 command
bun run Shopping.ts list groceries.yaml --tier 3

# Output: Formatted links by retailer
```

---

## Phase 2: REI Browser Automation

**Why REI first:**
- User's preferred store
- Has membership (10% dividend)
- Has gift card balance
- Less aggressive bot detection than Amazon

### Commands

```bash
# Login and save session
bun run Shopping.ts rei login

# Add items to cart
bun run Shopping.ts rei add "Flash 22 Pack"
bun run Shopping.ts rei add "Patagonia Better Sweater" --size M

# View cart (with screenshot)
bun run Shopping.ts rei cart

# Check session status
bun run Shopping.ts rei status
```

### Implementation Pattern (Follow Instacart)

```typescript
// Session file location
const SESSION_FILE = join(homedir(), '.pai-shopping/sessions/rei.json')

// REI-specific selectors
const REI_SELECTORS = {
  search: 'input[data-testid="search-input"]',
  addToCart: 'button[data-testid="add-to-cart"]',
  sizeSelect: 'select[data-testid="size-select"]',
  cartIcon: '[data-testid="cart-icon"]',
  loginIndicator: '[data-testid="account-menu"]'
}

// Security: Encrypted session storage
async function saveSession(context: BrowserContext): Promise<void> {
  const storage = await context.storageState()
  // Use system keychain for encryption
  await encryptAndStore('rei-session', JSON.stringify(storage))
  await auditLog('session_saved', { retailer: 'rei' })
}
```

### Visual Verification Gate

Before ANY cart modification:

```typescript
async function verifyAndAdd(page: Page, item: string): Promise<boolean> {
  // 1. Take screenshot
  const screenshot = await page.screenshot()

  // 2. Show to user
  console.log(`\n📸 Screenshot: ${screenshotPath}`)
  console.log(`\n🛒 About to add: ${item}`)
  console.log(`   Proceed? [y/N]: `)

  // 3. Wait for confirmation
  const confirmed = await waitForUserConfirmation()

  // 4. Log decision
  await auditLog('cart_add_attempt', {
    item,
    confirmed,
    screenshot: screenshotPath
  })

  return confirmed
}
```

---

## Phase 3: Second Retailer (Pattern Validation)

**Candidates:** Patagonia, Arc'teryx, or Nordstrom

This phase validates the adapter pattern works across retailers.

### Adapter Interface

```typescript
interface RetailerAdapter {
  name: string
  baseUrl: string
  selectors: RetailerSelectors

  login(): Promise<void>
  search(query: string): Promise<SearchResult[]>
  addToCart(item: CartItem): Promise<boolean>
  viewCart(): Promise<CartContents>
  getSessionStatus(): Promise<SessionStatus>
}
```

---

## Security Requirements

### 1. Encryption at Rest

```typescript
// Use system keychain
import { Keychain } from '@anthropic/keychain'

async function encryptAndStore(key: string, data: string): Promise<void> {
  await Keychain.setPassword('pai-shopping', key, data)
}

async function decryptAndLoad(key: string): Promise<string | null> {
  return await Keychain.getPassword('pai-shopping', key)
}
```

### 2. Session Expiry

```typescript
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24 hours

async function checkSessionAge(retailer: string): Promise<boolean> {
  const metadata = await loadSessionMetadata(retailer)
  const age = Date.now() - metadata.createdAt

  if (age > SESSION_TTL) {
    console.log(`⚠️ ${retailer} session expired. Re-authentication required.`)
    return false
  }
  return true
}
```

### 3. Rate Limiting

```typescript
const RATE_LIMIT = {
  maxActionsPerMinute: 5,
  cooldownMs: 12000  // 12 seconds between actions
}

let lastActionTime = 0

async function rateLimitedAction(action: () => Promise<void>): Promise<void> {
  const elapsed = Date.now() - lastActionTime
  if (elapsed < RATE_LIMIT.cooldownMs) {
    await sleep(RATE_LIMIT.cooldownMs - elapsed)
  }
  lastActionTime = Date.now()
  await action()
}
```

### 4. Audit Logging

```typescript
// All cart operations logged to MEMORY/shopping-audit.jsonl
interface AuditEntry {
  timestamp: string
  action: 'session_created' | 'session_saved' | 'cart_add_attempt' | 'cart_add_success' | 'cart_view' | 'checkout_blocked'
  retailer: string
  item?: string
  confirmed?: boolean
  screenshot?: string
  error?: string
}

async function auditLog(action: string, data: object): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    ...data
  }
  await appendFile(AUDIT_LOG, JSON.stringify(entry) + '\n')
}
```

### 5. Input Validation

```typescript
// Prevent injection attacks
function validateShoppingItem(item: unknown): CartItem {
  if (typeof item !== 'object' || !item) {
    throw new Error('Invalid item format')
  }

  const { name, quantity, size } = item as any

  // Sanitize
  if (typeof name !== 'string' || name.length > 200) {
    throw new Error('Invalid item name')
  }
  if (quantity && (typeof quantity !== 'number' || quantity < 1 || quantity > 10)) {
    throw new Error('Invalid quantity (1-10)')
  }

  return {
    name: sanitizeString(name),
    quantity: quantity || 1,
    size: size ? sanitizeString(size) : undefined
  }
}
```

---

## File Structure

```
skills/Shopping/
├── SKILL.md                    # Main skill doc (updated)
├── IMPLEMENTATION_SPEC.md      # This file
├── ShoppingProfile.md          # User preferences (existing)
├── Tools/
│   ├── Shopping.ts             # Main CLI tool
│   ├── adapters/
│   │   ├── base.ts             # Adapter interface
│   │   ├── rei.ts              # REI implementation
│   │   └── fallback.ts         # Tier 3 link generator
│   ├── security/
│   │   ├── session.ts          # Encrypted session management
│   │   └── audit.ts            # Audit logging
│   └── router.ts               # Shopping list router
├── Workflows/
│   ├── Research.md             # Existing
│   ├── QuickRecommend.md       # Existing
│   ├── AddToCart.md            # NEW: Cart automation workflow
│   └── ProcessList.md          # NEW: Shopping list processing
└── sessions/                   # .gitignored, encrypted sessions
```

---

## Usage Examples

### Example 1: Process Shopping List (Tier 3)

```
User: "Add these to my cart: REI Flash pack, Patagonia fleece"

→ Parses list, reads ShoppingProfile for sizes
→ Generates Tier 3 output with links
→ Offers to use browser automation if available
```

### Example 2: REI Automation (Tier 2)

```
User: "Add the REI Flash 22 Pack to my cart"

→ Check REI session status
→ If valid: launch headless browser
→ Search for item
→ Screenshot + confirmation prompt
→ User approves → add to cart
→ Audit log entry
→ Report success with cart link
```

### Example 3: Multi-Retailer List

```
User: Shopping list:
- REI: Flash 22 Pack, hiking socks
- Patagonia: Better Sweater (M)
- Nordstrom: dress shoes

→ Route items by retailer
→ REI items via Tier 2 (if session valid)
→ Patagonia/Nordstrom via Tier 3 (links)
→ Consolidated report
```

---

## Success Criteria

### Phase 1 (Tier 3)
- [ ] Parses shopping lists in YAML/natural language
- [ ] Generates curated search links for any retailer
- [ ] Applies user sizes from ShoppingProfile
- [ ] Notes gift cards and loyalty programs

### Phase 2 (REI Automation)
- [ ] Login flow with session persistence
- [ ] Encrypted session storage
- [ ] Search and add-to-cart functionality
- [ ] Visual verification gate (screenshot + confirm)
- [ ] Audit logging for all operations
- [ ] Rate limiting (5 actions/min)
- [ ] Session expiry (24h TTL)

### Phase 3 (Pattern Validation)
- [ ] Second retailer implemented
- [ ] Adapter pattern proven reusable
- [ ] No shared state between retailers
- [ ] Security gates consistent across adapters

---

## Next Steps

1. **Create directory structure** for new files
2. **Build Tier 3 fallback** (Tools/adapters/fallback.ts)
3. **Build REI adapter** following Instacart pattern
4. **Add security infrastructure** (session encryption, audit)
5. **Update SKILL.md** with new workflows
6. **Test with real shopping list**
