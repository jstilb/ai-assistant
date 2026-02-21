/**
 * Item Utilities - Quantity parsing and input sanitization
 *
 * Handles multi-format quantity parsing (3x Eggs, Eggs x3, 3 Eggs)
 * and sanitizes item names to prevent XSS/injection in DOM interactions.
 */

export interface ParsedItem {
  name: string;
  quantity: number;
}

/**
 * Parse an item string that may contain an inline quantity.
 *
 * Supported formats:
 * - "3x Eggs" or "3X Eggs" -> { name: "Eggs", quantity: 3 }
 * - "Eggs x3" or "Eggs X3" -> { name: "Eggs", quantity: 3 }
 * - "3 Eggs" -> { name: "Eggs", quantity: 3 }
 * - "Eggs" -> { name: "Eggs", quantity: 1 }
 *
 * Special handling:
 * - "2% milk" is treated as a name (not quantity 2), because the character
 *   after the number is not a space or 'x'
 */
export function parseItem(input: string): ParsedItem {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error('Item name cannot be empty');
  }

  // Pattern 1: "3x Eggs" or "3X Eggs" (number followed by x/X then space and name)
  // Also matches negative like "-1x Eggs" to catch and reject
  const prefixXMatch = trimmed.match(/^(-?\d+)\s*[xX]\s+(.+)$/);
  if (prefixXMatch) {
    const quantity = parseInt(prefixXMatch[1], 10);
    const name = prefixXMatch[2].trim();
    validateQuantity(quantity, trimmed);
    return { name, quantity };
  }

  // Pattern 2: "Eggs x3" or "Eggs X3" (name followed by x/X and number)
  const suffixXMatch = trimmed.match(/^(.+)\s+[xX](\d+)$/);
  if (suffixXMatch) {
    const name = suffixXMatch[1].trim();
    const quantity = parseInt(suffixXMatch[2], 10);
    validateQuantity(quantity, trimmed);
    return { name, quantity };
  }

  // Pattern 3: "3 Eggs" (number followed by space and name)
  // But NOT "2% milk" -- the character after the digit must be a space
  const numPrefixMatch = trimmed.match(/^(\d+)\s+([a-zA-Z].+)$/);
  if (numPrefixMatch) {
    const quantity = parseInt(numPrefixMatch[1], 10);
    const name = numPrefixMatch[2].trim();
    validateQuantity(quantity, trimmed);
    return { name, quantity };
  }

  // Default: entire string is the item name, quantity 1
  return { name: trimmed, quantity: 1 };
}

function validateQuantity(quantity: number, originalInput: string): void {
  if (quantity <= 0) {
    throw new Error(`Invalid quantity ${quantity} in "${originalInput}". Quantity must be a positive integer.`);
  }
  if (!Number.isInteger(quantity)) {
    throw new Error(`Invalid quantity ${quantity} in "${originalInput}". Quantity must be a positive integer.`);
  }
}

/**
 * Sanitize an item name for safe use in browser DOM interactions.
 *
 * Strips/escapes characters that could cause XSS or injection:
 * - HTML tags (<, >)
 * - Quotes (", ')
 * - Ampersand (&)
 * - Semicolons (;)
 * - Normalizes whitespace
 */
export function sanitizeItemName(input: string): string {
  if (!input) return '';

  let sanitized = input;

  // Strip HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, '');

  // Remove dangerous characters
  sanitized = sanitized.replace(/[<>"'&;]/g, '');

  // Normalize whitespace (collapse multiple spaces, trim)
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}
