import type { MetadataRoute } from 'next';
import { GAMES } from '@casino/shared/constants/games';

export default function sitemap(): MetadataRoute.Sitemap {
  const rawBase =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.FRONTEND_URL ||
    'https://2win2play.com';
  const baseUrl = rawBase.replace(/\/+$/, '');
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${baseUrl}/games`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${baseUrl}/bonuses`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/leaderboard`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/provably-fair`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/referral`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/support`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/signup`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/login`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];

  const gameRoutes: MetadataRoute.Sitemap = GAMES.map((game) => ({
    url: `${baseUrl}/games/${game.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));

  const legalSlugs = ['terms', 'privacy', 'responsible-gaming', 'fairness'];
  const legalRoutes: MetadataRoute.Sitemap = legalSlugs.map((slug) => ({
    url: `${baseUrl}/legal/${slug}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.4,
  }));

  return [...staticRoutes, ...gameRoutes, ...legalRoutes];
}
