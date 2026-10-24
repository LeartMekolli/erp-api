import { pathFor } from './path';

describe("a piece's path through its workflow", () => {
  // Given out of order: the path follows position.
  const steps = [
    { id: 'packing', stepTypeId: 'packing_type', priced: false, position: 6 },
    { id: 'print_pattern', stepTypeId: 'print_pattern_type', priced: true, position: 0 },
    { id: 'casting', stepTypeId: 'casting_type', priced: true, position: 2 },
    { id: 'casting_tree', stepTypeId: 'casting_tree_type', priced: true, position: 1 },
    { id: 'polishing', stepTypeId: 'polishing_type', priced: true, position: 3 },
    { id: 'plating', stepTypeId: 'plating_type', priced: true, position: 4 },
    { id: 'final_qc', stepTypeId: 'final_qc_type', priced: false, position: 5 },
  ];
  const polished = ['print_pattern_type', 'casting_tree_type', 'casting_type', 'polishing_type'];

  it('skips priced steps the order does not include, and keeps steps nobody prices', () => {
    expect(pathFor(steps, polished)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing', 'final_qc', 'packing']);
  });

  it('keeps a priced step once the order includes it', () => {
    expect(pathFor(steps, [...polished, 'plating_type'])).toEqual([
      'print_pattern',
      'casting_tree',
      'casting',
      'polishing',
      'plating',
      'final_qc',
      'packing',
    ]);
  });

  it('runs every step when there is no priced chain to follow', () => {
    expect(pathFor(steps, null)).toEqual(['print_pattern', 'casting_tree', 'casting', 'polishing', 'plating', 'final_qc', 'packing']);
  });

  it('keeps every step of a priced type the workflow has twice', () => {
    const twice = [...steps, { id: 'second_polish', stepTypeId: 'polishing_type', priced: true, position: 7 }];
    expect(pathFor(twice, ['polishing_type'])).toEqual(['polishing', 'final_qc', 'packing', 'second_polish']);
  });
});
