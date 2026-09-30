/**
 * CallDetector.test.ts - Unit tests for call detection logic
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { detectActiveCall, CallDetectorConfigSchema } from './CallDetector';
import type { CallDetectorConfig } from './CallDetector';

describe('CallDetector', () => {
  describe('CallDetectorConfigSchema', () => {
    it('parses valid config', () => {
      const config = CallDetectorConfigSchema.parse({
        enabled: true,
        detectApps: ['zoom', 'teams'],
        useMicDetection: true,
        timeoutMs: 500,
        allowCriticalOverride: true,
      });
      expect(config.enabled).toBe(true);
      expect(config.detectApps).toEqual(['zoom', 'teams']);
    });

    it('applies defaults for missing fields', () => {
      const config = CallDetectorConfigSchema.parse({});
      expect(config.enabled).toBe(true);
      expect(config.useMicDetection).toBe(true);
      expect(config.timeoutMs).toBe(500);
      expect(config.allowCriticalOverride).toBe(true);
      expect(config.detectApps).toEqual(['zoom', 'teams', 'discord', 'slack']);
    });

    it('rejects invalid app names', () => {
      expect(() =>
        CallDetectorConfigSchema.parse({ detectApps: ['invalid'] })
      ).toThrow();
    });
  });

  describe('detectActiveCall', () => {
    it('returns not-on-call when disabled', async () => {
      const result = await detectActiveCall({
        enabled: false,
        detectApps: ['zoom'],
        useMicDetection: true,
        timeoutMs: 500,
        allowCriticalOverride: true,
      });
      expect(result.onCall).toBe(false);
      expect(result.detectedVia).toBeNull();
    });

    it('returns a valid CallDetectionResult shape', async () => {
      // With real system calls (no mock) — just verify shape, not specific detection
      const result = await detectActiveCall({
        enabled: true,
        detectApps: ['zoom'],
        useMicDetection: false, // Skip mic check for fast test
        timeoutMs: 1000,
        allowCriticalOverride: true,
      });
      expect(typeof result.onCall).toBe('boolean');
      expect(result.detectedVia === null || typeof result.detectedVia === 'string').toBe(true);
    });

    it('completes within timeout even if processes are not found', async () => {
      const start = Date.now();
      await detectActiveCall({
        enabled: true,
        detectApps: ['zoom', 'teams'],
        useMicDetection: false,
        timeoutMs: 2000,
        allowCriticalOverride: true,
      });
      const elapsed = Date.now() - start;
      // Should complete well under the timeout since processes won't be found
      expect(elapsed).toBeLessThan(2000);
    });

    it('handles empty detectApps with mic detection off', async () => {
      const result = await detectActiveCall({
        enabled: true,
        detectApps: [],
        useMicDetection: false,
        timeoutMs: 500,
        allowCriticalOverride: true,
      });
      expect(result.onCall).toBe(false);
      expect(result.detectedVia).toBeNull();
    });
  });
});
