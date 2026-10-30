import { checkSources } from './recommendations';

describe('recommendations', () => {
  const urls = new Set(['https://trends.example.test/a', 'https://trends.example.test/b']);

  it('keeps only sources the run found, and keeps every idea and advice item with its other fields', () => {
    const output = {
      ideas: [
        { title: 'Stacking rings', why: 'Thin bands are trending.', sources: ['https://trends.example.test/a', 'https://made-up.example.test'] },
        { title: 'Initial pendants', why: 'From your own best sellers.', sources: [] },
        { title: 'Invented trend', why: 'Nowhere.', sources: ['https://made-up.example.test/x'] },
      ],
      advice: [{ text: 'Show pieces worn.', sources: ['https://trends.example.test/b', 'https://trends.example.test/b'] }],
    };

    expect(checkSources(output, urls)).toEqual({
      ideas: [
        { title: 'Stacking rings', why: 'Thin bands are trending.', sources: ['https://trends.example.test/a'] },
        { title: 'Initial pendants', why: 'From your own best sellers.', sources: [] },
        { title: 'Invented trend', why: 'Nowhere.', sources: [] },
      ],
      advice: [{ text: 'Show pieces worn.', sources: ['https://trends.example.test/b'] }],
    });
  });
});
