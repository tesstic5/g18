#!/usr/bin/env node
// apps/api/scripts/game-count.mjs — prints the number of seeded games; the
// production entrypoint uses it to decide whether to run dist/seed.js.
// Exit 1 (no output) when the DB cannot be read, so "empty" is never confused
// with "broken".
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const res = await client.query('SELECT COUNT(*)::int AS c FROM "GameConfig"');
  console.log(res.rows[0].c);
  await client.end();
} catch (e) {
  console.error('[game-count] probe failed:', e.message);
  process.exit(1);
}
