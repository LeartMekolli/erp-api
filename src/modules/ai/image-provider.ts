/**
 * The one way the API makes an image (AI 2 spec, goal 16). Our own shapes, beside `AiProvider`; only ever
 * called from a job, never inside a request or a database transaction.
 */
export interface ImageRequest {
  model: string;
  prompt: string;
  /** The image to change; absent: a new image. */
  source?: Buffer;
}

export interface ImageResult {
  bytes: Buffer;
  contentType: 'image/png';
}

export interface ImageProvider {
  create(request: ImageRequest): Promise<ImageResult>;
}

export const IMAGE_PROVIDER = Symbol('IMAGE_PROVIDER');
