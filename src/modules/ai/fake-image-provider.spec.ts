import { FakeImageProvider } from './fake-image-provider';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('FakeImageProvider', () => {
  it('returns a PNG and records every request', async () => {
    const provider = new FakeImageProvider();
    const source = Buffer.from('the parent image');

    const created = await provider.create({ model: 'gpt-image-2.5-flare', prompt: 'A ring with a thin band' });
    const edited = await provider.create({ model: 'gpt-image-2.5-flare', prompt: 'Thinner band', source });

    expect(created.contentType).toBe('image/png');
    expect(created.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(edited.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(provider.calls).toEqual([
      { model: 'gpt-image-2.5-flare', prompt: 'A ring with a thin band' },
      { model: 'gpt-image-2.5-flare', prompt: 'Thinner band', source },
    ]);
  });

  it('throws the given error on the next call only', async () => {
    const provider = new FakeImageProvider();
    const error = new Error('the image service is down');
    provider.fail(error);

    await expect(provider.create({ model: 'gpt-image-2.5-flare', prompt: 'A vase' })).rejects.toBe(error);
    await expect(provider.create({ model: 'gpt-image-2.5-flare', prompt: 'A vase' })).resolves.toMatchObject({ contentType: 'image/png' });
    expect(provider.calls).toHaveLength(2);
  });
});
