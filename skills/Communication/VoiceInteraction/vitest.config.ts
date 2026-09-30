import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['Tools/.vitest/**/*.test.ts'],
    exclude: [],
    coverage: {
      provider: 'v8',
      include: ['Tools/**/*.ts'],
      exclude: ['Tools/.vitest/**', 'Tools/**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './Tools'),
    },
  },
});
