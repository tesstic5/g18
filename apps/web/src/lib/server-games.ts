// apps/web/src/lib/server-games.ts — server-side games fetch (used by lobby + /games pages).
// Runs only on the server (Node fetch). INTERNAL_API_URL points at the API container:
// dev → http://localhost:4000/api/v1, docker prod → http://api:4000/api/v1.
export interface LobbyGame {
  slug: string;
  displayName: string;
  description?: string | null;
  thumbnailUrl?: string | null;
  category: string[];
  tags: string[];
  demoEnabled: boolean;
  baseRtp?: number | string;
  minBet?: number | string;
}

export async function fetchGamesServer(): Promise<LobbyGame[]> {
  const base = process.env.INTERNAL_API_URL || 'http://localhost:4000/api/v1';
  try {
    const res = await fetch(`${base}/games`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: LobbyGame[] };
    return json.data ?? [];
  } catch {
    return []; // client will retry; page still renders
  }
}
