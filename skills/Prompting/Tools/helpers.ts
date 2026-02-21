/**
 * helpers.ts - Shared Handlebars helpers for Prompting tools
 *
 * Single source of truth for all custom Handlebars helpers.
 * Used by RenderTemplate.ts, PromptLoader.ts, and AgentFactory.ts.
 *
 * Consolidates duplicate registrations that previously existed across:
 * - RenderTemplate.ts (17 helpers)
 * - PromptLoader.ts (12 helpers, subset of RenderTemplate)
 *
 * All helpers are registered idempotently via the _registered guard.
 */

import Handlebars from 'handlebars';

let _registered = false;

/**
 * Register all custom Handlebars helpers (idempotent)
 */
export function registerHelpers(): void {
  if (_registered) return;

  // --- Text Transformation ---
  Handlebars.registerHelper('uppercase', (str: string) => str?.toUpperCase() ?? '');
  Handlebars.registerHelper('lowercase', (str: string) => str?.toLowerCase() ?? '');
  Handlebars.registerHelper('titlecase', (str: string) =>
    str?.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()) ?? ''
  );

  // --- Formatting ---
  Handlebars.registerHelper('indent', (str: string, spaces: number) => {
    if (!str) return '';
    const indent = ' '.repeat(typeof spaces === 'number' ? spaces : 2);
    return str.split('\n').map((line) => indent + line).join('\n');
  });
  Handlebars.registerHelper('join', (arr: string[], separator: string) => {
    if (!Array.isArray(arr)) return '';
    return arr.join(typeof separator === 'string' ? separator : ', ');
  });
  Handlebars.registerHelper('truncate', (str: string, length: number) => {
    if (!str) return '';
    const maxLen = typeof length === 'number' ? length : 100;
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  });
  Handlebars.registerHelper('pluralize', (count: number, singular: string, plural?: string) => {
    const pluralForm = typeof plural === 'string' ? plural : `${singular}s`;
    return count === 1 ? singular : pluralForm;
  });
  Handlebars.registerHelper('formatNumber', (num: number) => {
    return num?.toLocaleString() ?? '';
  });
  Handlebars.registerHelper('percent', (value: number, total: number, decimals = 0) => {
    if (!total) return '0';
    return ((value / total) * 100).toFixed(typeof decimals === 'number' ? decimals : 0);
  });

  // --- Comparison ---
  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
  Handlebars.registerHelper('lt', (a: number, b: number) => a < b);
  Handlebars.registerHelper('includes', (arr: unknown[], value: unknown) =>
    Array.isArray(arr) && arr.includes(value)
  );

  // --- Date/Time ---
  Handlebars.registerHelper('now', (format?: string) => {
    const now = new Date();
    if (format === 'date') return now.toISOString().split('T')[0];
    if (format === 'time') return now.toTimeString().split(' ')[0];
    return now.toISOString();
  });

  // --- Defaults & Serialization ---
  Handlebars.registerHelper('default', (value: unknown, defaultValue: unknown) => value ?? defaultValue);
  Handlebars.registerHelper('json', (obj: unknown, pretty = false) =>
    JSON.stringify(obj, null, pretty ? 2 : undefined)
  );

  // --- Code & Blocks ---
  Handlebars.registerHelper('codeblock', (code: string, language?: string) => {
    const lang = typeof language === 'string' ? language : '';
    return new Handlebars.SafeString('`' + '`' + '`' + lang + '\n' + code + '\n' + '`' + '`' + '`');
  });
  Handlebars.registerHelper('repeat', (count: number, options: Handlebars.HelperOptions) => {
    let result = '';
    for (let i = 0; i < count; i++) {
      result += options.fn({ index: i, first: i === 0, last: i === count - 1 });
    }
    return result;
  });

  _registered = true;
}
