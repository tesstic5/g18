import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, toCSV } from './csv';

describe('csvCell formula neutralization', () => {
  it('prefixes formula-leading characters', () => {
    expect(csvCell('=SUM(1,2)')).toBe(`"'=SUM(1,2)"`);
    expect(csvCell('+cmd')).toBe(`"'+cmd"`);
    expect(csvCell('-1+1')).toBe(`"'-1+1"`);
    expect(csvCell('@HYPERLINK("x")')).toBe(`"'@HYPERLINK(""x"")"`);
  });

  it('leaves ordinary text alone', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(42)).toBe('42');
  });

  it('escapes quotes and wraps commas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('toCSV writes a header + rows', () => {
    const out = toCSV([
      { name: '=CMD', amount: '10' },
      { name: 'ok', amount: '1' },
    ]);
    expect(out.split('\n')[0]).toBe('name,amount');
    expect(out).toContain(`"'=CMD"`);
  });

  it('csvRow joins cells', () => {
    expect(csvRow(['id', '=1+1'])).toBe(`id,"'=1+1"`);
  });
});
