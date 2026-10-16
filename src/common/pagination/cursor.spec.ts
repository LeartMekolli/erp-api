import { createHmac } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';

const SECRET = 's'.repeat(32);
const ID = '01a145c3-7e73-728d-9d82-1f426e70d11e';

describe('cursor', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor({ id: ID }, SECRET), SECRET)).toEqual({ id: ID });
  });

  it('rejects a cursor with a flipped character', () => {
    const cursor = encodeCursor({ id: ID }, SECRET);
    const flipped = `${cursor.slice(0, 5)}${cursor[5] === 'A' ? 'B' : 'A'}${cursor.slice(6)}`;

    expect(() => decodeCursor(flipped, SECRET)).toThrow(BadRequestException);
  });

  it('rejects a cursor signed with another secret', () => {
    const cursor = encodeCursor({ id: ID }, 'o'.repeat(32));

    expect(() => decodeCursor(cursor, SECRET)).toThrow(BadRequestException);
  });

  it.each(['', 'abc', 'a.b.c', '.', 'a.'])('rejects the malformed cursor %j', (cursor) => {
    expect(() => decodeCursor(cursor, SECRET)).toThrow(BadRequestException);
  });

  it('rejects a correctly signed payload whose id is not a uuid', () => {
    const payload = Buffer.from(JSON.stringify({ id: 'not-a-uuid' })).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');

    expect(() => decodeCursor(`${payload}.${signature}`, SECRET)).toThrow(BadRequestException);
  });
});
