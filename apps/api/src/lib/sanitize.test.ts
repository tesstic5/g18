import { describe, expect, it } from 'vitest';
import { sanitizeRichText } from './sanitize';

describe('sanitizeRichText', () => {
  it('keeps the legal-content allow-list', () => {
    expect(sanitizeRichText('<h2>Terms</h2><p><strong>Hello</strong></p>')).toContain(
      '<strong>Hello</strong>'
    );
  });

  it.each([
    '<script>alert(1)</script><p>safe</p>',
    '<img src=x onerror=alert(1)>',
    '<a href="java&#x73;cript:alert(1)">bad</a>',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    '<math><mtext><a href="data:text/html,x">x</a></mtext></math>',
  ])('removes executable markup: %s', (payload) => {
    const clean = sanitizeRichText(payload).toLowerCase();
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('data:text/html');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('<svg');
    expect(clean).not.toContain('<math');
  });
});
