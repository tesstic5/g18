import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const rawBase =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.FRONTEND_URL ||
    'https://2win2play.com';
  const baseUrl = rawBase.replace(/\/+$/, '');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/panel/', '/profile', '/wallet', '/offline'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
