/**
 * Base adapter interface for Shopping skill retailers
 *
 * Each retailer implements this interface for consistent behavior.
 * Session isolation: each adapter manages its own session independently.
 */

export interface CartItem {
  name: string
  quantity: number
  size?: string
  color?: string
  url?: string
}

export interface SearchResult {
  name: string
  price: string
  url: string
  imageUrl?: string
  inStock: boolean
  sizes?: string[]
}

export interface CartContents {
  items: Array<{
    name: string
    price: string
    quantity: number
    size?: string
  }>
  subtotal: string
  itemCount: number
}

export interface SessionStatus {
  valid: boolean
  expiresAt?: Date
  retailer: string
}

export interface RetailerSelectors {
  search: string
  searchButton?: string
  addToCart: string
  sizeSelect?: string
  quantityInput?: string
  cartIcon: string
  loginIndicator: string
  cartItem?: string
  cartTotal?: string
}

/**
 * Retailer adapter interface
 *
 * Implementations must be stateless - all state is in session files.
 */
export interface RetailerAdapter {
  /** Retailer identifier (lowercase, no spaces) */
  name: string

  /** Display name for UI */
  displayName: string

  /** Base URL for the retailer */
  baseUrl: string

  /** CSS selectors for page elements */
  selectors: RetailerSelectors

  /** Open browser for manual login, save session */
  login(): Promise<void>

  /** Search for products */
  search(query: string): Promise<SearchResult[]>

  /** Add item to cart (requires user confirmation) */
  addToCart(item: CartItem): Promise<boolean>

  /** View current cart contents */
  viewCart(): Promise<CartContents>

  /** Check if session is valid */
  getSessionStatus(): Promise<SessionStatus>

  /** Clear saved session */
  logout(): Promise<void>
}

/**
 * Shopping list item from user input
 */
export interface ShoppingListItem {
  name: string
  quantity?: number
  size?: string
  color?: string
  retailer?: string
  notes?: string
}

/**
 * Parsed shopping list with items grouped by retailer
 */
export interface ParsedShoppingList {
  items: ShoppingListItem[]
  byRetailer: Map<string, ShoppingListItem[]>
}

/**
 * Result from processing a shopping list
 */
export interface ShoppingListResult {
  retailer: string
  tier: 1 | 2 | 3
  items: Array<{
    item: ShoppingListItem
    status: 'added' | 'link_generated' | 'failed'
    url?: string
    error?: string
  }>
}

/**
 * User profile from ShoppingProfile.md
 */
export interface ShoppingProfile {
  sizes: {
    tops: string
    bottoms: string
    shoes: string
  }
  giftCards: Array<{
    store: string
    balance?: string
  }>
  preferredStores: string[]
  excludedBrands: string[]
  loyaltyPrograms: Array<{
    store: string
    benefits: string
  }>
}
