import { lineState, orderState } from './order-state';

describe('a line state', () => {
  const pieces = (...statuses: string[]) => statuses.map((status) => ({ status }));

  it('is in production while a piece is active', () => {
    expect(lineState(pieces('active', 'active'), null)).toBe('in_production');
    expect(lineState(pieces('finished', 'active'), null)).toBe('in_production');
  });

  it('is ready once every live piece is finished, whatever was scrapped or cancelled', () => {
    expect(lineState(pieces('finished', 'finished'), null)).toBe('ready');
    expect(lineState(pieces('finished', 'scrapped', 'cancelled'), null)).toBe('ready');
  });

  it('is in production with no live piece yet, as when a scrapped piece is still to be remade', () => {
    expect(lineState(pieces('scrapped'), null)).toBe('in_production');
    expect(lineState([], null)).toBe('in_production');
  });

  it('is cancelled once cancelled, whatever its pieces', () => {
    expect(lineState(pieces('finished', 'cancelled'), new Date())).toBe('cancelled');
  });
});

describe('an order state', () => {
  const at = new Date('2026-11-02T10:00:00Z');

  it('is in production while a line is', () => {
    expect(orderState(['in_production', 'ready'], null, null)).toBe('in_production');
    expect(orderState(['in_production', 'cancelled'], null, null)).toBe('in_production');
  });

  it('is ready when every line is ready or cancelled and at least one is ready', () => {
    expect(orderState(['ready', 'ready'], null, null)).toBe('ready');
    expect(orderState(['ready', 'cancelled'], null, null)).toBe('ready');
  });

  it('is cancelled when every line is cancelled', () => {
    expect(orderState(['cancelled', 'cancelled'], null, null)).toBe('cancelled');
  });

  it('is shipped once shipped, then delivered once delivered', () => {
    expect(orderState(['ready', 'cancelled'], at, null)).toBe('shipped');
    expect(orderState(['ready'], at, at)).toBe('delivered');
  });
});
