import { Prisma } from '../../../generated/prisma/client';
import { localDateTime } from '../../orders/dates';

// The one CSV format of every export (Reporting 2 spec, goal 8): UTF-8 with a BOM so spreadsheet programs
// read accents right, commas, CRLF lines, money with two places, times in the workspace's time zone.

/** A cell: text, a whole number, money, an instant, or empty. A date without a time is passed as text. */
export type CsvCell = string | number | Prisma.Decimal | Date | null;

export interface CsvColumn {
  key: string;
  label: string;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Text a spreadsheet would run as a formula starts with one of these (Review Focus 1). */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell, timeZone: string): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  if (value instanceof Prisma.Decimal) return value.toFixed(2);
  if (value instanceof Date) return localDateTime(value, timeZone);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One line, without its line end. */
export function csvLine(cells: CsvCell[], timeZone: string): string {
  return cells.map((value) => cell(value, timeZone)).join(',');
}

/** A whole file: the BOM, the header of `columns`' labels, then each row's cells in `columns`' order. */
export function csvFile(columns: CsvColumn[], rows: Record<string, CsvCell>[], timeZone: string): Buffer {
  const lines = [columns.map((column) => cell(column.label, timeZone)).join(',')];
  for (const row of rows) lines.push(csvLine(columns.map((column) => row[column.key] ?? null), timeZone));
  return Buffer.concat([BOM, Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
}
