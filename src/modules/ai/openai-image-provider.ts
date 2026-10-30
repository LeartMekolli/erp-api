import OpenAI, { toFile } from 'openai';
import type { ImageProvider, ImageRequest, ImageResult } from './image-provider';

/**
 * Images through OpenAI's Images API: `generate` for a new image, `edit` to change one. One square PNG at
 * medium quality, the size and quality the cost table prices. Never called by a test.
 */
export class OpenAiImageProvider implements ImageProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async create(request: ImageRequest): Promise<ImageResult> {
    const shape = { model: request.model, prompt: request.prompt, n: 1, size: '1024x1024', quality: 'medium', output_format: 'png' } as const;
    const response = request.source
      ? await this.client.images.edit({ ...shape, image: await toFile(request.source, 'source.png', { type: 'image/png' }) })
      : await this.client.images.generate(shape);
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) {
      throw new Error('The image provider returned no image');
    }
    return { bytes: Buffer.from(encoded, 'base64'), contentType: 'image/png' };
  }
}
