// apps/api/src/db/minio.ts — MinIO/S3 client singleton (v7 §5 presigned uploads)
//
// TWO endpoints matter here and they are NOT the same:
//
//   S3_ENDPOINT        where the API talks to storage. Inside Docker this is an
//                      internal hostname (http://minio:9000) that only other
//                      containers can resolve.
//   S3_PUBLIC_ENDPOINT what the BROWSER must use. A presigned URL is handed to
//                      the user's browser, so it has to contain a publicly
//                      reachable host (https://yourdomain.com/storage).
//
// Signing a URL against the internal host and giving it to a browser produces
// `ERR_NAME_NOT_RESOLVED` / `ENOTFOUND minio` — the upload silently fails even
// though storage is perfectly healthy. That was the deposit-proof bug.
import { Client } from 'minio';

interface ParsedEndpoint {
  endPoint: string;
  port: number;
  useSSL: boolean;
  /** Path prefix when storage is served under a sub-path (e.g. /storage). */
  pathPrefix: string;
}

/**
 * Parse an endpoint URL into MinIO client options.
 *
 * The previous implementation used ad-hoc string splitting:
 *   port: parseInt(S3_ENDPOINT.split(':').pop() || '9000')
 * which yields NaN for any URL WITHOUT an explicit port
 * ("https://s3.amazonaws.com".split(':').pop() === "//s3.amazonaws.com"),
 * so hosted S3 endpoints crashed the client on construction.
 */
export function parseEndpoint(
  raw: string | undefined,
  fallback = 'http://localhost:9000'
): ParsedEndpoint {
  let url: URL;
  try {
    url = new URL(raw && raw.trim() ? raw : fallback);
  } catch {
    url = new URL(fallback);
  }
  const useSSL = url.protocol === 'https:';
  const port = url.port ? parseInt(url.port, 10) : useSSL ? 443 : 80;
  const pathPrefix = url.pathname.replace(/\/+$/, '');
  return { endPoint: url.hostname, port, useSSL, pathPrefix };
}

const internal = parseEndpoint(process.env.S3_ENDPOINT);

// region PINNED (correction #9, 2026-08-21): without it, minio-js resolves the
// bucket region with `GET ?location` at every presign/putObject — a LIVE network
// call. When the signing endpoint is an HTTPS host with a self-signed cert
// (Dokploy default cert on the minio domain), that lookup dies with
// `DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate` and presigning fails
// even though storage is perfectly healthy — that was the production
// `/deposits/upload-url` → SVC_503 incident. Pinning the region (MinIO default
// is us-east-1) makes signing 100% local and immune to TLS/DNS breakage.
const S3_REGION = process.env.S3_REGION || 'us-east-1';

export const MinioClient = new Client({
  endPoint: internal.endPoint,
  port: internal.port,
  useSSL: internal.useSSL,
  accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
  region: S3_REGION,
});

/**
 * Client used to SIGN browser-facing URLs.
 *
 * When S3_PUBLIC_ENDPOINT is set we sign against that host so the resulting URL
 * is reachable from the user's browser. The signature covers the host, so the
 * URL must be signed with the public host from the start — rewriting the host
 * afterwards would invalidate it.
 */
const publicEnv = process.env.S3_PUBLIC_ENDPOINT;
const publicCfg = publicEnv ? parseEndpoint(publicEnv) : null;

export const MinioPublicClient = publicCfg
  ? new Client({
      endPoint: publicCfg.endPoint,
      port: publicCfg.port,
      useSSL: publicCfg.useSSL,
      accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
      region: S3_REGION, // pinned — never do a ?location lookup during presign
      // Behind a reverse proxy the bucket lives under a path prefix
      // (nginx: location /storage/ → minio:9000), so path-style is required.
      pathStyle: true,
    })
  : MinioClient;

/** True when the deployment still signs URLs with an internal-only hostname. */
export function usingInternalHostForBrowser(): boolean {
  if (publicCfg) return false;
  // A bare hostname with no dot (e.g. "minio") is a Docker service name and is
  // not resolvable by a browser. localhost is fine for local development.
  const h = internal.endPoint;
  return !h.includes('.') && h !== 'localhost' && h !== '127.0.0.1';
}

/**
 * Ensure the object-storage buckets exist (idempotent). Called once at API
 * startup so the first deposit upload works without touching the MinIO console.
 * Non-fatal: if MinIO is unreachable the API still boots (uploads just fail
 * until it's back — deposit rows can still be created without a proof image).
 */
export async function ensureBuckets(): Promise<void> {
  const buckets = [
    process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs',
    process.env.S3_BUCKET_AVATARS || 'user-avatars',
  ];
  for (const bucket of buckets) {
    try {
      if (!(await MinioClient.bucketExists(bucket))) {
        await MinioClient.makeBucket(bucket);
      }
    } catch (e) {
      console.warn(`[minio] bucket "${bucket}" not ensured:`, (e as Error).message);
    }
  }

  if (usingInternalHostForBrowser()) {
    console.warn(
      `[minio] S3_ENDPOINT host "${internal.endPoint}" is not resolvable by a browser. ` +
        'Presigned upload URLs will fail with ERR_NAME_NOT_RESOLVED. ' +
        'Set S3_PUBLIC_ENDPOINT to a publicly reachable URL (e.g. https://yourdomain.com/storage).'
    );
  }
}
