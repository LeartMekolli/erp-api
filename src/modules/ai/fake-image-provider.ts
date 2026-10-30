import type { ImageProvider, ImageRequest, ImageResult } from './image-provider';

/** A valid 1×1 transparent PNG. */
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** In memory, for local work and tests: always the same small PNG, unless told to fail; records every request. */
export class FakeImageProvider implements ImageProvider {
  readonly calls: ImageRequest[] = [];
  private failure: Error | null = null;

  /** The next call throws `error`; the ones after succeed again. */
  fail(error: Error): void {
    this.failure = error;
  }

  create(request: ImageRequest): Promise<ImageResult> {
    this.calls.push(request);
    const failure = this.failure;
    this.failure = null;
    if (failure) {
      return Promise.reject(failure);
    }
    return Promise.resolve({ bytes: Buffer.from(SAMPLE_PNG), contentType: 'image/png' });
  }
}
