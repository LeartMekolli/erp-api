import { mapWithLimit } from './map-with-limit';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithLimit', () => {
  it("keeps the items' order", async () => {
    expect(await mapWithLimit([30, 10, 20], 2, async (ms) => (await wait(ms), ms))).toEqual([30, 10, 20]);
  });

  it('never runs more than the limit at once', async () => {
    let pending = 0;
    let highest = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 5, async (item) => {
      pending += 1;
      highest = Math.max(highest, pending);
      await wait(10);
      pending -= 1;
      return item;
    });
    expect(highest).toBe(5);
  });

  it('handles an empty list', async () => {
    const fn = jest.fn();
    expect(await mapWithLimit([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
