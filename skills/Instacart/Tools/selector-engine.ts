/**
 * SelectorEngine - Config-driven CSS selector resolution with fallback chains
 *
 * Resolves elements using a priority chain of CSS selectors with
 * exponential backoff between retries. Returns structured results
 * including which selector succeeded and timing information.
 */

export interface SelectorConfig {
  primary: string;
  fallbacks: string[];
}

export interface SelectorConfigEntry extends SelectorConfig {
  description?: string;
}

export interface ResolvedSelector {
  element: unknown;
  selectorUsed: string;
  attemptCount: number;
  fallbackLevel: number;
  durationMs: number;
}

export type SelectorResult =
  | { success: true; data: ResolvedSelector }
  | { success: false; error: Error };

export interface SelectorEngineOptions {
  maxRetries: number;
  backoffBaseMs: number;
}

const DEFAULT_OPTIONS: SelectorEngineOptions = {
  maxRetries: 3,
  backoffBaseMs: 1000,
};

export class SelectorEngine {
  private readonly options: SelectorEngineOptions;

  constructor(options: Partial<SelectorEngineOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Resolve an element on the page using a priority chain of selectors.
   *
   * Tries the primary selector first with exponential backoff retries,
   * then iterates through fallbacks in order. Each fallback gets
   * a single attempt (no retries on fallbacks - they exist for
   * variety, not transient failures).
   */
  async resolve(
    page: { $(selector: string): Promise<unknown | null>; waitForTimeout(ms: number): Promise<void> },
    config: SelectorConfig
  ): Promise<SelectorResult> {
    const startTime = Date.now();
    let totalAttempts = 0;

    // Try primary selector with retries + backoff
    for (let retry = 0; retry < this.options.maxRetries; retry++) {
      totalAttempts++;

      const element = await page.$(config.primary);
      if (element) {
        return {
          success: true,
          data: {
            element,
            selectorUsed: config.primary,
            attemptCount: totalAttempts,
            fallbackLevel: 0,
            durationMs: Date.now() - startTime,
          },
        };
      }

      // Exponential backoff before next retry (skip wait on last attempt)
      if (retry < this.options.maxRetries - 1) {
        const backoffMs = this.options.backoffBaseMs * Math.pow(2, retry);
        await page.waitForTimeout(backoffMs);
      }
    }

    // Try each fallback selector (single attempt each)
    for (let i = 0; i < config.fallbacks.length; i++) {
      totalAttempts++;
      const selector = config.fallbacks[i];

      const element = await page.$(selector);
      if (element) {
        return {
          success: true,
          data: {
            element,
            selectorUsed: selector,
            attemptCount: totalAttempts,
            fallbackLevel: i + 1,
            durationMs: Date.now() - startTime,
          },
        };
      }
    }

    return {
      success: false,
      error: new Error(
        `All selectors failed for config. Primary: "${config.primary}", ` +
        `Fallbacks tried: ${config.fallbacks.length}. ` +
        `Total attempts: ${totalAttempts}`
      ),
    };
  }
}
