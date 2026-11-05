import { describe, it, expect } from 'vitest';
import { isRoutableIp, clientIpCountry } from './fraud';

describe('isRoutableIp', () => {
  it('rejects empty, loopback and RFC1918', () => {
    expect(isRoutableIp(null)).toBe(false);
    expect(isRoutableIp('')).toBe(false);
    expect(isRoutableIp('unknown')).toBe(false);
    expect(isRoutableIp('127.0.0.1')).toBe(false);
    expect(isRoutableIp('::1')).toBe(false);
    expect(isRoutableIp('10.0.0.4')).toBe(false);
    expect(isRoutableIp('192.168.1.10')).toBe(false);
    expect(isRoutableIp('172.16.0.1')).toBe(false);
    expect(isRoutableIp('172.31.255.1')).toBe(false);
    expect(isRoutableIp('169.254.1.1')).toBe(false);
  });
  it('accepts public v4', () => {
    expect(isRoutableIp('8.8.8.8')).toBe(true);
    expect(isRoutableIp('39.40.1.2')).toBe(true);
    expect(isRoutableIp('172.32.0.1')).toBe(true);
  });
});

describe('clientIpCountry', () => {
  it('reads CF / Vercel country headers and drops XX', () => {
    expect(clientIpCountry({ 'cf-ipcountry': 'PK' })).toBe('PK');
    expect(clientIpCountry({ 'x-vercel-ip-country': 'ae' })).toBe('AE');
    expect(clientIpCountry({ 'cf-ipcountry': 'XX' })).toBe(null);
    expect(clientIpCountry({})).toBe(null);
  });
});
