import { describe, it, expect } from 'vitest';
import sitemap from './sitemap';
import robots from './robots';
import { GAMES } from '@casino/shared/constants/games';

describe('sitemap', () => {
  it('generates all static, game, and legal routes', () => {
    const map = sitemap();
    expect(Array.isArray(map)).toBe(true);

    const urls = map.map((entry) => entry.url);

    // Root and primary pages
    expect(urls).toContain('https://2win2play.com/');
    expect(urls).toContain('https://2win2play.com/games');
    expect(urls).toContain('https://2win2play.com/bonuses');
    expect(urls).toContain('https://2win2play.com/leaderboard');
    expect(urls).toContain('https://2win2play.com/provably-fair');
    expect(urls).toContain('https://2win2play.com/referral');
    expect(urls).toContain('https://2win2play.com/support');
    expect(urls).toContain('https://2win2play.com/signup');
    expect(urls).toContain('https://2win2play.com/login');

    // All registered games
    for (const game of GAMES) {
      expect(urls).toContain(`https://2win2play.com/games/${game.slug}`);
    }

    // Legal pages
    expect(urls).toContain('https://2win2play.com/legal/terms');
    expect(urls).toContain('https://2win2play.com/legal/privacy');
    expect(urls).toContain('https://2win2play.com/legal/responsible-gaming');
    expect(urls).toContain('https://2win2play.com/legal/fairness');

    // Expected total count: 9 static + 20 games + 4 legal = 33
    expect(map.length).toBe(9 + GAMES.length + 4);
  });
});

describe('robots', () => {
  it('generates proper robot rules and sitemap link', () => {
    const config = robots();
    expect(config.sitemap).toBe('https://2win2play.com/sitemap.xml');
    expect(config.rules).toBeDefined();
    const rules = Array.isArray(config.rules) ? config.rules : [config.rules];
    const firstRule = rules[0]!;
    expect(firstRule.allow).toBe('/');
    expect(firstRule.disallow).toContain('/panel/');
    expect(firstRule.disallow).toContain('/profile');
    expect(firstRule.disallow).toContain('/wallet');
  });
});
