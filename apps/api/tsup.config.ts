// apps/api/tsup.config.ts — production bundling for API + seed.
//
// The workspace packages (@casino/shared, @casino/game-core) ship raw TS via
// their `exports` map, so they MUST be folded into the bundle: a plain
// `node dist/server.js` only works if nothing it imports is TypeScript.
// (Previously they were externalised and production boot silently depended on
// Node 22.18+'s default type-stripping resolving through pnpm symlinks — one
// Node/image change away from ERR_UNKNOWN_FILE_EXTENSION on boot.)
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    server: 'src/server.ts',
    // Seed is bundled too: the production entrypoint runs `node dist/seed.js`
    // (empty-DB bootstrap) without tsx or any of src/ present in the image.
    seed: 'prisma/seed.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: true,
  noExternal: [/^@casino\/(shared|game-core)(\/.*)?$/],
});
