import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { ObjectStorage } from './object-storage';

/**
 * Types a browser may show in place (plan S8). Everything else, SVG and HTML
 * included, downloads, so an uploaded script never runs on the storage domain.
 */
export const INLINE_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
];

/**
 * `Content-Disposition` for a download. The name loses control characters,
 * quotes and path separators, so it can neither add a header nor name a path;
 * `filename` carries an ASCII fallback and `filename*` the UTF-8 name (RFC 6266).
 */
export function contentDisposition(fileName: string, contentType: string): string {
  const baseType = contentType.split(';')[0].trim().toLowerCase();
  const disposition = INLINE_CONTENT_TYPES.includes(baseType) ? 'inline' : 'attachment';

  let name = fileName
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim();
  if (/^\.*$/.test(name)) {
    name = 'download';
  }

  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]|%/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** `ObjectStorage` over the S3 API: MinIO locally, Cloudflare R2 in production (plan S1). */
export class S3Storage implements ObjectStorage, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get('S3_BUCKET');
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT'),
      region: config.get('S3_REGION'),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE') === 'true',
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
      },
      // Otherwise the SDK adds a checksum of the (empty) body to presigned
      // PUTs, which storage then holds the real upload to.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    });
    // The presigner leaves Content-Type unsigned by default; signing both
    // headers makes storage refuse any other type or size (plan S4).
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  presignGet(
    key: string,
    options: { fileName: string; contentType: string; expiresInSeconds: number },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: contentDisposition(options.fileName, options.contentType),
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? '' };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async read(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!(result.Body instanceof Readable)) {
      throw new Error(`Object ${key} has no readable body`);
    }
    return result.Body;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
