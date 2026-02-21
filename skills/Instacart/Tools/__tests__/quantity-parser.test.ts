import { describe, test, expect } from 'bun:test';
import { parseItem, sanitizeItemName, type ParsedItem } from '../item-utils';

describe('parseItem - quantity parsing', () => {
  test('parses "3x Eggs" format', () => {
    const result = parseItem('3x Eggs');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(3);
  });

  test('parses "3X Eggs" format (uppercase X)', () => {
    const result = parseItem('3X Eggs');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(3);
  });

  test('parses "Eggs x3" format', () => {
    const result = parseItem('Eggs x3');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(3);
  });

  test('parses "Eggs X3" format (uppercase X)', () => {
    const result = parseItem('Eggs X3');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(3);
  });

  test('parses "3 Eggs" format', () => {
    const result = parseItem('3 Eggs');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(3);
  });

  test('bare "Eggs" defaults to quantity 1', () => {
    const result = parseItem('Eggs');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(1);
  });

  test('handles "organic whole milk" with no quantity', () => {
    const result = parseItem('organic whole milk');
    expect(result.name).toBe('organic whole milk');
    expect(result.quantity).toBe(1);
  });

  test('handles "2x organic bananas" with multi-word item', () => {
    const result = parseItem('2x organic bananas');
    expect(result.name).toBe('organic bananas');
    expect(result.quantity).toBe(2);
  });

  test('handles "organic bananas x2" with multi-word item', () => {
    const result = parseItem('organic bananas x2');
    expect(result.name).toBe('organic bananas');
    expect(result.quantity).toBe(2);
  });

  test('rejects zero quantity', () => {
    expect(() => parseItem('0x Eggs')).toThrow();
  });

  test('rejects negative quantity', () => {
    expect(() => parseItem('-1x Eggs')).toThrow();
  });

  test('rejects empty string', () => {
    expect(() => parseItem('')).toThrow();
  });

  test('rejects whitespace-only string', () => {
    expect(() => parseItem('   ')).toThrow();
  });

  test('trims whitespace from item name', () => {
    const result = parseItem('  Eggs  ');
    expect(result.name).toBe('Eggs');
    expect(result.quantity).toBe(1);
  });

  test('handles "12x Paper towels" (double-digit quantity)', () => {
    const result = parseItem('12x Paper towels');
    expect(result.name).toBe('Paper towels');
    expect(result.quantity).toBe(12);
  });

  test('does not parse item names that start with numbers but are not quantities', () => {
    // "2% milk" should NOT be parsed as quantity 2, name "% milk"
    const result = parseItem('2% milk');
    expect(result.name).toBe('2% milk');
    expect(result.quantity).toBe(1);
  });
});

describe('sanitizeItemName - input sanitization', () => {
  test('strips HTML tags', () => {
    const result = sanitizeItemName('<script>alert(1)</script>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  test('escapes double quotes', () => {
    const result = sanitizeItemName('chicken "breast"');
    expect(result).not.toContain('"');
  });

  test('escapes single quotes', () => {
    const result = sanitizeItemName("Ben & Jerry's");
    expect(result).not.toContain("'");
  });

  test('escapes ampersand', () => {
    const result = sanitizeItemName('Eggs & Bacon');
    expect(result).toContain('Eggs');
    expect(result).toContain('Bacon');
    expect(result).not.toContain('&');
  });

  test('strips semicolons', () => {
    const result = sanitizeItemName('eggs; DROP TABLE');
    expect(result).not.toContain(';');
  });

  test('preserves normal item names', () => {
    expect(sanitizeItemName('organic bananas')).toBe('organic bananas');
    expect(sanitizeItemName('whole milk')).toBe('whole milk');
    expect(sanitizeItemName('large eggs')).toBe('large eggs');
  });

  test('handles SQL injection attempt', () => {
    const result = sanitizeItemName('"; DROP TABLE items; --');
    expect(result).not.toContain('"');
    expect(result).not.toContain(';');
  });

  test('handles empty string gracefully', () => {
    const result = sanitizeItemName('');
    expect(result).toBe('');
  });

  test('trims excessive whitespace', () => {
    const result = sanitizeItemName('  organic   milk  ');
    expect(result).toBe('organic milk');
  });
});
