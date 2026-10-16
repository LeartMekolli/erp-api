import { newId } from './uuid';

describe('newId', () => {
  it('returns a version 7 uuid', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sorts chronologically as a string', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId();

    expect([second, first].sort()).toEqual([first, second]);
  });

  it('stays ordered within the same millisecond', () => {
    const ids = Array.from({ length: 50 }, () => newId());

    expect([...ids].sort()).toEqual(ids);
  });

  it('does not repeat', () => {
    const ids = Array.from({ length: 1000 }, () => newId());

    expect(new Set(ids).size).toBe(1000);
  });
});
