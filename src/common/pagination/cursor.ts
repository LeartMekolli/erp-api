import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Lists sort by id descending: a v7 id orders by creation time, so the id
 * alone is the whole sort key (ADR 0004). The work queue sorts by its group's
 * queue rank first, so its cursor carries the rank as well (Customers 2). A list with a choice of sort
 * carries the sort the cursor was made for and the last row's value of it (Orders list spec, goal 9).
 */
const cursorPayloadSchema = z.object({
  id: z.uuid(),
  rank: z.number().int().min(0).optional(),
  sort: z.string().max(20).optional(),
  key: z.string().max(40).optional(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

function sign(payloadPart: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

/** `base64url(json).base64url(hmac)`: opaque to clients, tamper-evident to us. */
export function encodeCursor(payload: CursorPayload, secret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadPart}.${sign(payloadPart, secret).toString('base64url')}`;
}

/**
 * Anything that is not a cursor we signed is a 400: an unsigned cursor would
 * let a caller page from an arbitrary position.
 */
export function decodeCursor(cursor: string, secret: string): CursorPayload {
  const invalid = new BadRequestException('Invalid cursor');
  const parts = cursor.split('.');
  const [payloadPart, signaturePart] = parts;

  if (parts.length !== 2 || !payloadPart || !signaturePart) {
    throw invalid;
  }

  const expected = sign(payloadPart, secret);
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalid;
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    return cursorPayloadSchema.parse(decoded);
  } catch {
    throw invalid;
  }
}
