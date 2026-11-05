// apps/api/src/services/backupTables.test.ts — guards the backup inventory
// against the schema.
//
// The failure this prevents is silent: add a model, forget the list, and every
// JSON export skips that table while every restore leaves it empty. No error is
// raised anywhere — an operator only notices the day they need the data. So this
// test diffs the lists against prisma/schema.prisma AND checks both orderings
// against the real foreign keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLES, WIPE_ORDER } from './backupTables';

const schema = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8'
);

/** model name → the models it holds a foreign key to (owner side of @relation). */
function foreignKeys(): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const blocks = schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  for (const [, name, body] of blocks) {
    if (!name || !body) continue;
    const targets: string[] = [];
    // Only relations that declare `fields:` own the FK; back-relations
    // (`user User[]`) do not create a constraint that ordering must respect.
    for (const rel of body.matchAll(/(\w+)\s+(\w+)(?:\[\])?\??\s+@relation\(\s*fields:/g)) {
      targets.push(rel[2]!);
    }
    models.set(name, targets);
  }
  return models;
}

const models = foreignKeys();
const modelNames = [...models.keys()].sort();

describe('backup table inventory', () => {
  it('parses the schema (guards against a silently empty test)', () => {
    expect(modelNames.length).toBeGreaterThan(20);
    expect(modelNames).toContain('User');
  });

  it('covers every model in the schema — nothing is left un-backed-up', () => {
    expect([...TABLES].sort()).toEqual(modelNames);
    expect([...WIPE_ORDER].sort()).toEqual(modelNames);
  });

  it('has no duplicate entries', () => {
    expect(new Set(TABLES).size).toBe(TABLES.length);
    expect(new Set(WIPE_ORDER).size).toBe(WIPE_ORDER.length);
  });

  it('inserts parents before children (TABLES)', () => {
    const at = new Map<string, number>(TABLES.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const [model, targets] of models) {
      for (const target of targets) {
        if (target === model) continue; // self-reference: no ordering constraint
        if (!at.has(target)) continue; // covered by the coverage test above
        if (!(at.get(target)! < at.get(model)!)) {
          violations.push(`${model} (index ${at.get(model)}) is inserted before its parent ${target} (index ${at.get(target)})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('deletes children before parents (WIPE_ORDER)', () => {
    const at = new Map<string, number>(WIPE_ORDER.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const [model, targets] of models) {
      for (const target of targets) {
        if (target === model) continue;
        if (!at.has(target)) continue;
        if (!(at.get(model)! < at.get(target)!)) {
          violations.push(`${model} (index ${at.get(model)}) is deleted after its parent ${target} (index ${at.get(target)})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('carries the recovery/hardening tables that were previously omitted', () => {
    for (const t of ['PasswordHistory', 'RecoveryRequest', 'SecurityAlert', 'WalletAdjustment']) {
      expect(TABLES).toContain(t);
      expect(WIPE_ORDER).toContain(t);
    }
  });
});
