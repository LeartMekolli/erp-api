import { finalKeyFor, uploadKeyFor } from './storage-keys';

describe('storage keys', () => {
  it('builds the final key from ids alone', () => {
    expect(finalKeyFor('t1', 'f1', 'v1')).toBe('files/t1/f1/v1');
  });

  it('derives the upload key from the final key', () => {
    expect(uploadKeyFor('files/t1/f1/v1')).toBe('uploads/t1/f1/v1');
  });

  it('refuses a key that is not a final key', () => {
    expect(() => uploadKeyFor('uploads/t1/f1/v1')).toThrow(/final storage key/);
    expect(() => uploadKeyFor('t1/f1/v1')).toThrow(/final storage key/);
  });
});
