// eslint.config.js — FLAT config (ESLint 9+).
//
// The repo previously shipped only `.eslintrc.cjs`, which ESLint 10 ignores
// entirely unless ESLINT_USE_FLAT_CONFIG=false — so `pnpm lint` was silently
// linting nothing. It also extended `next/core-web-vitals` without
// `eslint-config-next` being installed anywhere, which would have errored.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      // generated Prisma client
      'apps/api/src/generated/**',
      // ad-hoc e2e scripts (plain node, run manually)
      'apps/web/e2e/**',
      // local probe/simulation scripts — gitignored, not part of the app
      'apps/api/scratch/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Handler signatures (Fastify `reply`, BaseGame.resolve's `isWin` /
          // `forceMode`) must match their interface even when a given
          // implementation doesn't need every field. Only flag an unused arg
          // when everything AFTER it is unused too.
          args: 'after-used',
          ignoreRestSiblings: true,
          // Destructured-but-unused keys are the idiomatic way to omit fields
          // (e.g. `const { updatedAt, ...rest } = config`).
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Flags `let x = false;` immediately before a switch/loop that reassigns
      // it — a normal, readable pattern here. Not worth restructuring code for.
      'no-useless-assignment': 'off',
    },
  },
  {
    // Standalone diagnostic script — printing to stdout is the entire point.
    files: ['apps/api/src/probe.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Server code legitimately logs to stdout.
    files: ['apps/worker/**/*.ts', 'apps/api/prisma/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // React components destructure the full props contract even when a given
    // game panel doesn't use every field (`config`, `setChoices`, …). Warn so
    // it stays visible without failing the build on an intentional pattern.
    //
    // The react-hooks / @next plugins are registered here because the codebase
    // already contains inline `eslint-disable react-hooks/exhaustive-deps` and
    // `@next/next/no-img-element` directives — without the plugins those
    // directives themselves error ("Definition for rule ... was not found").
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      // Small static brand assets (logo.svg, wordmark.png) and blob/data-URL
      // previews. next/image adds no value for a fixed-size inline SVG and
      // cannot optimise a client-side object URL, so a plain <img> is correct
      // here. Game thumbnails that DO benefit already use next/image.
      '@next/next/no-img-element': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // `set-state-in-effect` fires on the game components' animation triggers:
      // when a new server outcome arrives, an effect kicks off the dice tumble /
      // coin toss / wheel spin. That is a legitimate use of an effect — reacting
      // to external data — not the render-phase cascade the rule targets.
      //
      // Audited: every occurrence has a dependency array, and the four that
      // could in principle self-trigger are guarded by an equality check
      // (e.g. ChatWidget's `convo.id !== convoId`). No infinite loops; the
      // repo's render-loop test also covers this. Kept as a warning so genuinely
      // new offenders stay visible rather than being silenced outright.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/component-hook-factories': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // M-20: ops scripts are plain Node ESM — lint them with Node globals so
    // `process`/`console`/`setTimeout` don't trip no-undef.
    files: ['scripts/**/*.mjs', 'apps/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // k6 load scripts run inside the k6 runtime, which injects __ENV, __VU,
    // __ITER and a WebCrypto-ish `crypto`. They are never bundled with the app.
    files: ['scripts/load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // Service worker: runs in the ServiceWorkerGlobalScope, not the DOM or Node,
    // so `self`, `caches`, `fetch` and `URL` are globals ESLint does not know
    // about here. This produced 19 no-undef errors on a file that is correct.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        clients: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        location: 'readonly',
      },
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Test harnesses deliberately hoist a ref out of a component to drive it
      // from the test body.
      'react-hooks/globals': 'off',
    },
  },
  prettier
);
