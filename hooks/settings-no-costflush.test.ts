import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// S1 removal assertion: settings.json must not reference SessionEndCostFlush
describe("settings.json — CostTracker removal (S1)", () => {
  it("settings.json no longer contains SessionEndCostFlush", () => {
    const settingsPath = join(import.meta.dir, "../settings.json");
    const content = readFileSync(settingsPath, 'utf-8');
    expect(content).not.toContain('SessionEndCostFlush');
  });
});
