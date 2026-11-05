import { describe, expect, it } from 'vitest';
import {
  adminGameDto,
  balanceDto,
  gameDetailDto,
  parseDto,
  withdrawalFeeDto,
} from './dto';

describe('API DTO parsing', () => {
  it('normalizes Prisma Decimal strings at the boundary', () => {
    expect(
      parseDto(
        balanceDto,
        { real: '10.50', bonus: '2', gifted: 0, locked: '0' },
        'balance'
      )
    ).toEqual({ real: 10.5, bonus: 2, gifted: 0, locked: 0 });
    expect(
      parseDto(withdrawalFeeDto, { percent: 2, fee: '1.00', net: '49.00' }, 'fee')
    ).toEqual({ percent: 2, fee: 1, net: 49 });
  });

  it('rejects malformed monetary data instead of crashing later in render', () => {
    expect(() =>
      parseDto(balanceDto, { real: 'NaN', bonus: 0, gifted: 0, locked: 0 }, 'balance')
    ).toThrow('balance response was invalid');
  });

  it('parses critical game/admin payloads', () => {
    expect(
      gameDetailDto.safeParse({
        slug: 'dice',
        displayName: 'Dice',
        baseRtp: '96',
        minBet: '10',
        maxWinMultiplier: '25',
      }).success
    ).toBe(true);
    expect(
      adminGameDto.safeParse({
        slug: 'dice',
        displayName: 'Dice',
        baseRtp: '96',
        winRate: '48',
        maxWinMultiplier: '25',
        configJson: {},
        totalRounds: 0,
        totalWagered: '0',
        totalPaidOut: '0',
        effectiveRtp: null,
      }).success
    ).toBe(true);
  });
});
