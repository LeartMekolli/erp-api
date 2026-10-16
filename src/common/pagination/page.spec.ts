import { decodeCursor } from './cursor';
import { paginationQuerySchema, toPage } from './page';

const SECRET = 's'.repeat(32);
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `01a145c3-7e73-728d-9d82-${String(index).padStart(12, '0')}`,
  }));

describe('toPage', () => {
  it('returns limit rows and a cursor pointing at the last one when there are more', () => {
    const page = toPage(rows(3), 2, SECRET);

    expect(page.data).toHaveLength(2);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeCursor(page.next_cursor ?? '', SECRET)).toEqual({ id: page.data[1]?.id });
  });

  it.each([2, 1, 0])('returns no cursor when %i rows fit within the limit', (count) => {
    const page = toPage(rows(count), 2, SECRET);

    expect(page.data).toHaveLength(count);
    expect(page.next_cursor).toBeNull();
  });
});

describe('paginationQuerySchema', () => {
  it('defaults the limit to 50', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('coerces a query-string limit', () => {
    expect(paginationQuerySchema.parse({ limit: '20', cursor: 'x' })).toEqual({
      limit: 20,
      cursor: 'x',
    });
  });

  it.each(['0', '201', '1.5', 'abc'])('rejects the limit %s', (limit) => {
    expect(() => paginationQuerySchema.parse({ limit })).toThrow();
  });
});
