// apps/api/src/lib/tar.ts — a minimal, dependency-free tar (posix ustar).
//
// WHY HAND-ROLLED: the platform must be able to write and read ONE archive that
// holds the database plus every uploaded image, and the API has no tar/zip
// dependency (adding one means another supply-chain surface for a file format
// that has not changed since 1988). This implements exactly what the backup
// needs and nothing else:
//
//   - ustar headers with the `prefix` field, so object keys longer than 100
//     characters still fit (an S3 key is arbitrary; silently truncating one
//     would corrupt a restore)
//   - GNU long-name ('L') entries on READ, because that is what `tar` writes
//     when a path is too long even for prefix+name — the Windows/Linux command
//     line tools must be able to produce an archive this API can restore
//   - pax ('x'/'g') headers are skipped, not treated as files
//   - no per-entry checksum: tar has none. Integrity comes from the gzip CRC32
//     trailer (corruption makes gunzip fail) plus the sizes recorded in the
//     archive's manifest.json, which the restore verifies.
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/** Octal field, NUL-terminated (the classic tar numeric encoding). */
function octal(value: number, length: number): Buffer {
  const s = value.toString(8).padStart(length - 1, '0');
  if (s.length > length - 1) throw new Error(`tar: value ${value} does not fit in ${length} bytes`);
  return Buffer.from(s + '\0', 'latin1');
}

/**
 * Split a path into the ustar name/prefix pair. Returns null when the path is
 * too long for the format (the caller should then use a GNU long-name entry).
 */
function splitName(path: string): { name: string; prefix: string } | null {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes <= NAME_MAX) return { name: path, prefix: '' };
  // Prefer splitting at a '/' so that the remainder fits in `name`.
  let cut = -1;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== '/') continue;
    const suffix = path.slice(i + 1);
    const prefix = path.slice(0, i);
    if (
      Buffer.byteLength(suffix, 'utf8') <= NAME_MAX &&
      Buffer.byteLength(prefix, 'utf8') <= PREFIX_MAX
    ) {
      cut = i; // keep looking: the LAST valid split gives the shortest suffix
    }
  }
  if (cut === -1) return null;
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}

export interface TarHeaderOptions {
  mtime?: Date;
  mode?: number;
  typeflag?: string;
}

/** Build one 512-byte ustar header block. */
export function tarHeader(path: string, size: number, opts: TarHeaderOptions = {}): Buffer {
  const block = Buffer.alloc(BLOCK);
  const typeflag = opts.typeflag ?? '0';
  let name = path;
  let prefix = '';
  if (typeflag === '0' || typeflag === '5') {
    const split = splitName(path);
    if (split) {
      name = split.name;
      prefix = split.prefix;
    } else if (typeflag === '0') {
      throw new Error(`tar: path too long (${Buffer.byteLength(path)} bytes): ${path}`);
    }
  }

  block.write(name, 0, NAME_MAX, 'utf8');
  octal(opts.mode ?? 0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124);
  octal(Math.floor((opts.mtime ?? new Date()).getTime() / 1000), 12).copy(block, 136);
  block.fill(0x20, 148, 156); // checksum field = spaces while computing
  block.write(typeflag, 156, 1, 'latin1');
  // linkname stays zero-filled
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write('root', 265, 32, 'utf8'); // uname
  block.write('root', 297, 32, 'utf8'); // gname
  block.write(prefix, 345, PREFIX_MAX, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += block[i]!;
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  block.write(chk, 148, 8, 'latin1');
  return block;
}

/**
 * Truncate a path to at most `max` BYTES without splitting a multi-byte
 * character. Used for the placeholder name in a GNU long-name pair.
 */
function truncateToBytes(value: string, max: number): string {
  if (Buffer.byteLength(value, 'utf8') <= max) return value;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (used + len > max) break;
    out += ch;
    used += len;
  }
  return out;
}

function padding(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/**
 * Writes a tar stream: add entries, then finish(). Entries are written in the
 * order they are added, and a stream entry is piped straight through, so a large
 * object never has to be buffered in memory.
 */
export class TarPacker {
  private readonly out: Writable;
  private closed = false;

  constructor(out: Writable) {
    this.out = out;
  }

  private write(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('tar: packer already finished'));
      this.out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Writes the header for one entry, emitting a GNU long-name ('L') pair first
   * when the path does not fit the ustar name+prefix fields. Without this, an
   * object key longer than 255 bytes is unrunnable — and S3 keys are arbitrary,
   * so "the upload had a long filename" would break the whole backup.
   */
  private async writeHeader(path: string, size: number, opts: TarHeaderOptions): Promise<void> {
    if (splitName(path)) {
      await this.write(tarHeader(path, size, opts));
      return;
    }
    const nameBuf = Buffer.concat([Buffer.from(path, 'utf8'), Buffer.from([0])]);
    await this.write(tarHeader('././@LongLink', nameBuf.length, { typeflag: 'L', mode: 0 }));
    await this.write(nameBuf);
    const pad = padding(nameBuf.length);
    if (pad) await this.write(Buffer.alloc(pad));
    // The real header carries a truncated placeholder; readers use the 'L' name.
    await this.write(tarHeader(truncateToBytes(path, NAME_MAX - 1), size, opts));
  }

  async addBuffer(path: string, data: Buffer, opts: TarHeaderOptions = {}): Promise<void> {
    await this.writeHeader(path, data.length, opts);
    if (data.length) await this.write(data);
    const pad = padding(data.length);
    if (pad) await this.write(Buffer.alloc(pad));
  }

  async addStream(path: string, size: number, src: Readable, opts: TarHeaderOptions = {}): Promise<void> {
    await this.writeHeader(path, size, opts);
    if (size > 0) await pipeline(src, this.out, { end: false });
    const pad = padding(size);
    if (pad) await this.write(Buffer.alloc(pad));
  }

  /** Two zero blocks close the archive, as the format requires. */
  async finish(): Promise<void> {
    if (this.closed) return;
    await this.write(Buffer.alloc(BLOCK * 2));
    this.closed = true;
  }
}

export interface ReadTarEntry {
  name: string;
  size: number;
  data: Buffer;
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  // Accept both NUL- and space-terminated fields (GNU writes the latter).
  const raw = buf.toString('latin1', offset, offset + length).replace(/\0.*$/, '').trim();
  if (raw === '') return 0;
  const value = parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Read a tar stream. Entry bodies are buffered, which is fine for the archive
 * this API produces (a JSON database bundle plus images of a few MB each) and
 * keeps the reader impossible to desync — a partially-consumed stream body would
 * silently shift every following entry.
 */
export async function* readTar(stream: Readable): AsyncGenerator<ReadTarEntry> {
  let pending: Buffer = Buffer.alloc(0);
  const iterator = stream[Symbol.asyncIterator]();
  let done = false;

  const fill = async (need: number): Promise<boolean> => {
    while (pending.length < need) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return pending.length >= need;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    }
    return true;
  };

  const take = (n: number): Buffer => {
    const out = Buffer.from(pending.subarray(0, n));
    pending = pending.subarray(n);
    return out;
  };

  let longName: string | null = null;

  while (true) {
    if (!(await fill(BLOCK))) return;
    const header = take(BLOCK);
    if (header.every((b) => b === 0)) return; // end-of-archive marker
    const given = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (sum !== given) {
      throw new Error('tar: header checksum mismatch — archive is corrupt');
    }

    const typeflag = header.toString('latin1', 156, 157);
    const size = readOctal(header, 124, 12);
    const rawName = header.toString('utf8', 0, NAME_MAX).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 345 + PREFIX_MAX).replace(/\0.*$/, '');
    const declared = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);

    if (size > 0) {
      if (!(await fill(size))) throw new Error(`tar: truncated entry ${declared}`);
      const data = take(size);
      const pad = padding(size);
      if (pad) {
        await fill(pad);
        take(pad);
      }
      if (typeflag === 'L') {
        // GNU long name: the body IS the name of the following entry.
        longName = data.toString('utf8').replace(/\0.*$/, '');
        continue;
      }
      if (typeflag === 'x' || typeflag === 'g') continue; // pax headers: skip
      if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
        yield { name: declared, size, data };
        longName = null;
        continue;
      }
      // directories, links and anything else: no body to hand back
      longName = null;
      continue;
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      yield { name: declared, size: 0, data: Buffer.alloc(0) };
    }
    longName = null;
    if (done && pending.length === 0) return;
  }
}
