import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['vitest.setup.ts'],
    testTimeout: 20_000,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**'],
  },
});
