// apps/web/src/app/(player)/games/page.tsx — GAMES listing (fixes the /games 404)
import { fetchGamesServer } from '../../../lib/server-games';
import { LobbyClient } from '../../../components/games/LobbyClient';

export const metadata = { title: 'Games' };

export default async function GamesPage() {
  const games = await fetchGamesServer();
  return <LobbyClient initialGames={games} title="Games" />;
}
