import { checkCards } from './marketing';

describe('marketing insights', () => {
  const keys = new Set(['orders_90d', 'spend_90d']);

  it('keeps only the figures the run gave, and drops a card left with none', () => {
    const cards = [
      { title: 'Order more often', advice: 'You order twice a quarter.', figures: ['orders_90d'] },
      { title: 'Spend', advice: 'Your spend grew.', figures: ['spend_90d', 'made_up'] },
      { title: 'Invented', advice: 'A number from nowhere.', figures: ['made_up'] },
    ];

    expect(checkCards(cards, keys)).toEqual([
      { title: 'Order more often', advice: 'You order twice a quarter.', figures: ['orders_90d'] },
      { title: 'Spend', advice: 'Your spend grew.', figures: ['spend_90d'] },
    ]);
  });

  it('cites each figure once per card', () => {
    expect(checkCards([{ title: 'Twice', advice: 'Same figure.', figures: ['spend_90d', 'spend_90d'] }], keys)).toEqual([
      { title: 'Twice', advice: 'Same figure.', figures: ['spend_90d'] },
    ]);
  });
});
