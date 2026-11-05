import { describe, expect, it } from 'vitest';
import { delegateName } from './backup';

describe('backup Prisma delegate mapping', () => {
  it('maps model names to real lower-camel Prisma delegates', () => {
    expect(delegateName('User')).toBe('user');
    expect(delegateName('GameConfig')).toBe('gameConfig');
    expect(delegateName('DepositPackage')).toBe('depositPackage');
    expect(delegateName('RefreshTokenFamily')).toBe('refreshTokenFamily');
  });
});
