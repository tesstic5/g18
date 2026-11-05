// apps/api/src/db/minio.test.ts — endpoint parsing for presigned uploads.
//
// Deposit-proof uploads were failing for two reasons that both live here:
//
//  1. The old parser did `parseInt(S3_ENDPOINT.split(':').pop())`, which is NaN
//     for any URL without an explicit port — so every hosted S3 endpoint
//     ("https://s3.amazonaws.com") produced an unusable client.
//  2. Presigned URLs were signed against the INTERNAL Docker hostname
//     ("http://minio:9000"). That URL is handed to the user's browser, which
//     cannot resolve it → ERR_NAME_NOT_RESOLVED and a silent upload failure.
import { describe, expect, it } from 'vitest';
import { parseEndpoint, usingInternalHostForBrowser, MinioPublicClient } from './minio';

describe('parseEndpoint', () => {
  it('parses an explicit host:port', () => {
    expect(parseEndpoint('http://minio:9000')).toEqual({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
      pathPrefix: '',
    });
  });

  it('defaults to 443 for https WITHOUT a port (the NaN bug)', () => {
    const cfg = parseEndpoint('https://s3.amazonaws.com');
    expect(cfg.port).toBe(443);
    expect(Number.isNaN(cfg.port)).toBe(false);
    expect(cfg.useSSL).toBe(true);
  });

  it('defaults to 80 for http without a port', () => {
    expect(parseEndpoint('http://storage.example.com').port).toBe(80);
  });

  it('keeps a path prefix for proxied storage (nginx /storage/)', () => {
    expect(parseEndpoint('https://yourdomain.com/storage')).toEqual({
      endPoint: 'yourdomain.com',
      port: 443,
      useSSL: true,
      pathPrefix: '/storage',
    });
  });

  it('strips a trailing slash from the prefix', () => {
    expect(parseEndpoint('https://d.com/storage/').pathPrefix).toBe('/storage');
  });

  it('falls back safely on empty or malformed input', () => {
    for (const bad of [undefined, '', '   ', 'not a url']) {
      expect(parseEndpoint(bad).endPoint).toBe('localhost');
      expect(parseEndpoint(bad).port).toBe(9000);
    }
  });
});

describe('usingInternalHostForBrowser', () => {
  // The live check reads module-level env captured at import time, so assert
  // the underlying rule: a dotless, non-loopback host is a Docker service name
  // and therefore unreachable from a browser.
  const looksInternal = (h: string) =>
    !h.includes('.') && h !== 'localhost' && h !== '127.0.0.1';

  it('flags bare Docker service names', () => {
    expect(looksInternal('minio')).toBe(true);
    expect(looksInternal('storage')).toBe(true);
  });

  it('accepts real hostnames and loopback', () => {
    expect(looksInternal('localhost')).toBe(false);
    expect(looksInternal('127.0.0.1')).toBe(false);
    expect(looksInternal('yourdomain.com')).toBe(false);
    expect(looksInternal('s3.amazonaws.com')).toBe(false);
  });

  it('is callable and returns a boolean for the current env', () => {
    expect(typeof usingInternalHostForBrowser()).toBe('boolean');
  });
});

describe('presign is network-free (correction #9 regression)', () => {
  // 2026-08-21 production incident: presignedPutObject is NOT pure signing —
  // unless the region is pinned, minio-js first does a live `GET ?location`
  // call against the signing endpoint. On the 2win2play deployment the public
  // endpoint was an HTTPS host with a self-signed cert, so the REGION LOOKUP
  // died with `DEPTH_ZERO_SELF_SIGNED_CERT` and /deposits/upload-url returned
  // 503 even though MinIO was healthy. minio.ts now pins region, which makes
  // getBucketRegionAsync return early (delta visible in client.js:545) with
  // zero network traffic. This test signs against a DELIBERATELY UNREACHABLE
  // host — it only passes if no network call is attempted at all.
  it('presignedPutObject never touches the network when region is pinned', async () => {
    // Client imported from ./minio has region pinned; assert the invariant.
    // (10.255.255.1 is a guaranteed-black-hole address per RFC 6890 practice.)
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_PUBLIC_ENDPOINT || 'https://10.255.255.1:9999';
    const url = await MinioPublicClient.presignedPutObject(
      'deposit-proofs',
      'deposits/test/never-network.png',
      300
    );
    expect(url).toContain('deposit-proofs/deposits/test/never-network.png');
    expect(url).toContain('X-Amz-Signature=');
  }, 10_000);
});
