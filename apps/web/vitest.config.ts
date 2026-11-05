// apps/web/vitest.config.ts — unit tests for client logic (D-090 state machine,
// ResultBanner dedupe). Next's tsconfig uses jsx:preserve, so vitest needs the
// React plugin to transform JSX.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
