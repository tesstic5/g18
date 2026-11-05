// apps/web/src/app/(player)/page.tsx — LOBBY (server component → SSR games, client hydration)
import { fetchGamesServer } from '../../lib/server-games';
import { LobbyClient } from '../../components/games/LobbyClient';

export default async function LobbyPage() {
  const games = await fetchGamesServer();
  return <LobbyClient initialGames={games} />;
}
