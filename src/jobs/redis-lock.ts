import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** Deletes the key only if it still holds this holder's token. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * A single-holder lock in Redis (ADR 0005.7). Each holder writes a random
 * token, so a holder whose lock expired mid-run cannot release the lock the
 * next holder has since taken. The TTL frees the lock if the holder dies.
 */
@Injectable()
export class RedisLock {
  private readonly logger = new Logger(RedisLock.name);

  constructor(private readonly redis: RedisService) {}

  async run<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<LockResult<T>> {
    const key = `lock:${name}`;
    const token = randomBytes(16).toString('hex');

    const acquired = await this.redis.client.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') {
      return { acquired: false };
    }

    try {
      return { acquired: true, value: await fn() };
    } finally {
      // A failed release leaves the lock to its TTL; the run itself succeeded.
      await this.redis.client.eval(RELEASE, 1, key, token).catch((error: unknown) => {
        this.logger.warn(`Could not release ${key}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
