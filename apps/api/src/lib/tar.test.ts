// apps/api/src/lib/tar.test.ts — the archive format is only useful if real tar
// can read what we write, and we can read what real tar writes. Both directions
// are exercised against the system `tar` binary when one is available.
import { describe, expect, it } from 'vitest';
import { createGunzip, createGzip } from 'node:zlib';
import { PassThrough, Readable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TarPacker, readTar, tarHeader } from './tar';

/** Collect a tar stream (optionally gzipped) into [{name, data}]. */
async function collect(stream: Readable): Promise<Array<{ name: string; data: Buffer }>> {
  const out: Array<{ name: string; data: Buffer }> = [];
  for await (const entry of readTar(stream)) out.push({ name: entry.name, data: entry.data });
  return out;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tar-test-'));
}

function hasSystemTar(): boolean {
  const probe = spawnSync('tar', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

describe('tar packer', () => {
  it('round-trips files, including empty and binary ones', async () => {
    const through = new PassThrough();
    const packer = new TarPacker(through);
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0x01]);

    void (async () => {
      await packer.addBuffer('manifest.json', Buffer.from('{"a":1}'));
      await packer.addBuffer('empty.txt', Buffer.alloc(0));
      await packer.addBuffer('objects/deposit-proofs/abc.bin', binary);
      await packer.finish();
      through.end();
    })();

    const entries = await collect(through);
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'empty.txt',
      'objects/deposit-proofs/abc.bin',
    ]);
    expect(entries[0]!.data.toString()).toBe('{"a":1}');
    expect(entries[1]!.data.length).toBe(0);
    expect(entries[2]!.data.equals(binary)).toBe(true);
  });

  it('stores a streamed entry without buffering it', async () => {
    const payload = Buffer.alloc(5000, 0x42);
    const through = new PassThrough();
    const packer = new TarPacker(through);

    void (async () => {
      await packer.addStream('big.bin', payload.length, Readable.from([payload]));
      await packer.finish();
      through.end();
    })();

    const entries = await collect(through);
    expect(entries[0]!.name).toBe('big.bin');
    expect(entries[0]!.data.equals(payload)).toBe(true);
  });

  it('uses the ustar prefix field for paths longer than 100 characters', () => {
    // 118 bytes total, but the FILENAME stays under 100 so the path splits into
    // prefix + name — the case the prefix field exists for.
    const long = 'objects/deposit-proofs/' + 'x'.repeat(90) + '.jpg';
    expect(Buffer.byteLength(long)).toBeGreaterThan(100);
    const header = tarHeader(long, 10);
    // name holds the tail, prefix the head, and re-joining them is lossless
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 345 + 155).replace(/\0.*$/, '');
    expect(`${prefix}/${name}`).toBe(long);
  });

  it('round-trips a path too long for ustar via a GNU long-name entry', async () => {
    // The filename alone exceeds 100 bytes, so even prefix+name cannot hold it.
    // GNU tar writes an 'L' entry in this case; so must we.
    const long = 'objects/deposit-proofs/' + 'y'.repeat(130) + '.jpg';
    const through = new PassThrough();
    const packer = new TarPacker(through);
    void (async () => {
      await packer.addBuffer(long, Buffer.from('img'));
      await packer.finish();
      through.end();
    })();
    const entries = await collect(through);
    expect(entries[0]!.name).toBe(long);
  });

  it('survives a gzip round trip', async () => {
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    gzip.on('data', (c: Buffer) => chunks.push(c));
    const packer = new TarPacker(gzip);
    const done = new Promise<void>((resolve) => gzip.on('end', () => resolve()));
    await packer.addBuffer('manifest.json', Buffer.from('{"ok":true}'));
    await packer.finish();
    gzip.end();
    await done;

    const entries = await collect(Readable.from(Buffer.concat(chunks)).pipe(createGunzip()));
    expect(entries[0]!.name).toBe('manifest.json');
    expect(entries[0]!.data.toString()).toBe('{"ok":true}');
  });

  it('refuses a corrupt header instead of returning garbage', async () => {
    const through = new PassThrough();
    const packer = new TarPacker(through);
    void (async () => {
      await packer.addBuffer('manifest.json', Buffer.from('{}'));
      await packer.finish();
      through.end();
    })();
    const entries = await collect(through);
    expect(entries).toHaveLength(1);

    // rebuild the same archive by hand and damage the checksum field
    const header = tarHeader('manifest.json', 2);
    header.write('99999\0 ', 148, 8, 'latin1');
    const body = Buffer.concat([header, Buffer.from('{}'), Buffer.alloc(510)]);
    await expect(collect(Readable.from(body))).rejects.toThrow(/checksum mismatch/);
  });

  it('stops at the end-of-archive marker even with trailing junk', async () => {
    const through = new PassThrough();
    const packer = new TarPacker(through);
    void (async () => {
      await packer.addBuffer('a.txt', Buffer.from('a'));
      await packer.finish();
      through.end();
    })();
    const archive = Buffer.concat(await collect_toBuffers(through));
    const withJunk = Buffer.concat([archive, Buffer.from('trailing garbage')]);
    const entries = await collect(Readable.from(withJunk));
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });
});

async function collect_toBuffers(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return chunks;
}

// ── interoperability with the real `tar` binary ────────────────────────────
describe('tar interop with system tar', () => {
  const skip = !hasSystemTar();

  it('writes an archive that system tar extracts byte-for-byte', async () => {
    if (skip) return;
    const dir = tempDir();
    try {
      const archive = join(dir, 'ours.tar.gz');
      const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      const gzip = createGzip();
      const chunks: Buffer[] = [];
      gzip.on('data', (c: Buffer) => chunks.push(c));
      const end = new Promise<void>((r) => gzip.on('end', () => r()));
      const packer = new TarPacker(gzip);
      await packer.addBuffer('manifest.json', Buffer.from('{"format":"test"}'));
      await packer.addBuffer('objects/deposit-proofs/a.bin', binary);
      await packer.addBuffer('objects/user-avatars/empty.txt', Buffer.alloc(0));
      await packer.finish();
      gzip.end();
      await end;
      writeFileSync(archive, Buffer.concat(chunks));

      const outDir = join(dir, 'out');
      mkdirSync(outDir);
      const res = spawnSync('tar', ['-xzf', archive, '-C', outDir]);
      expect(res.status).toBe(0);

      expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe('{"format":"test"}');
      expect(readFileSync(join(outDir, 'objects/deposit-proofs/a.bin')).equals(binary)).toBe(true);
      expect(existsSync(join(outDir, 'objects/user-avatars/empty.txt'))).toBe(true);
      expect(readFileSync(join(outDir, 'objects/user-avatars/empty.txt')).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an archive produced by system tar, including long paths', async () => {
    if (skip) return;
    const dir = tempDir();
    try {
      const src = join(dir, 'src');
      const deep = join(src, 'objects', 'deposit-proofs');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(src, 'manifest.json'), '{"from":"gnu tar"}');
      const longName = 'z'.repeat(120) + '.jpg'; // forces a GNU long-name entry
      writeFileSync(join(deep, longName), 'long-name-payload');
      writeFileSync(join(deep, 'short.jpg'), 'short-payload');

      const archive = join(dir, 'theirs.tar.gz');
      const res = spawnSync('tar', ['-czf', archive, '-C', src, '.']);
      expect(res.status).toBe(0);

      const entries = await collect(Readable.from(readFileSync(archive)).pipe(createGunzip()));
      const byName = new Map(entries.map((e) => [e.name.replace(/^\.\//, ''), e.data]));
      expect(byName.get('manifest.json')?.toString()).toBe('{"from":"gnu tar"}');
      expect(byName.get(`objects/deposit-proofs/${longName}`)?.toString()).toBe('long-name-payload');
      expect(byName.get('objects/deposit-proofs/short.jpg')?.toString()).toBe('short-payload');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
