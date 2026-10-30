import { Prisma } from '../../../generated/prisma/client';
import { csvFile, csvLine } from './csv';

const text = (buffer: Buffer) => buffer.toString('utf8');

describe('csv', () => {
  it('writes a BOM, a header and CRLF lines', () => {
    const file = csvFile(
      [
        { key: 'name', label: 'Name' },
        { key: 'orders', label: 'Orders' },
      ],
      [{ name: 'Luna Jewels', orders: 3 }],
      'UTC',
    );

    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(text(file.subarray(3))).toBe('Name,Orders\r\nLuna Jewels,3\r\n');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvLine(['a,b', 'say "hi"', 'two\nlines', 'plain'], 'UTC')).toBe('"a,b","say ""hi""","two\nlines",plain');
  });

  it('guards a cell a spreadsheet would run as a formula (Review Focus 1)', () => {
    expect(csvLine(['=SUM(A1)', '+1', '-x', '@a', '\tx', '\rx'], 'UTC')).toBe(`'=SUM(A1),'+1,'-x,'@a,'\tx,"'\rx"`);
    // Numbers are never guarded: a negative amount stays a number.
    expect(csvLine([new Prisma.Decimal('-12.5'), -3, new Prisma.Decimal('7')], 'UTC')).toBe('-12.50,-3,7.00');
  });

  it('writes times in the time zone, and nothing for null', () => {
    const at = new Date('2026-10-30T13:05:00Z');
    expect(csvLine([at, null], 'Europe/Berlin')).toBe('2026-10-30T14:05:00+01:00,');
    expect(csvLine([new Date('2026-07-01T10:00:00Z')], 'Europe/Berlin')).toBe('2026-07-01T12:00:00+02:00');
  });
});
