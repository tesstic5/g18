// apps/worker/tsup.config.ts — see apps/api/tsup.config.ts: workspace packages
// ship raw TS, so they must be folded into the bundle for plain-node boot.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: [/^@casino\/(shared|game-core)(\/.*)?$/, 'decimal.js'],
  // The generated Prisma client reaches for its WASM query-compiler via a
  // dynamic *_base64 import; esbuild wraps that as a dynamic require, which
  // throws in a bundled ESM artifact (only the WORKER bundles the client —
  // the API keeps @prisma/client in its dependencies, so it stays external
  // and loads from node_modules where the attribute survives).
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});
