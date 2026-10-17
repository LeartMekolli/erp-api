import { HttpException, HttpStatus, Injectable, Module } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Fixed-window counters in Redis, keyed `ratelimit:<name>:<key>`. The window
 * starts at the first hit and is not extended by later ones.
 */
@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Counts one attempt; false once the count is over the limit. */
  async hit(name: string, key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = this.key(name, key);
    const results = await this.redis.client.multi().incr(redisKey).expire(redisKey, windowSeconds, 'NX').exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    return count <= limit;
  }

  /** True when `limit` attempts are already counted, without counting another. */
  async isBlocked(name: string, key: string, limit: number): Promise<boolean> {
    return Number((await this.redis.client.get(this.key(name, key))) ?? 0) >= limit;
  }

  async reset(name: string, key: string): Promise<void> {
    await this.redis.client.del(this.key(name, key));
  }

  private key(name: string, key: string): string {
    return `ratelimit:${name}:${key}`;
  }
}

export function tooManyAttempts(): HttpException {
  return new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
}

@Module({ providers: [RateLimiter], exports: [RateLimiter] })
export class RateLimitModule {}
