import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.service';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      // Bounded, so a command against an unreachable Redis fails in roughly a
      // second instead of retrying indefinitely and hanging the readiness probe.
      maxRetriesPerRequest: 2,
      connectTimeout: 2000,
    });
    // Without a listener, a connection error is an unhandled 'error' event and
    // takes the process down. Readiness reports the state instead.
    this.client.on('error', () => undefined);
  }

  ping(): Promise<string> {
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Never connected, or already gone: drop the socket so the event loop
      // can drain.
      this.client.disconnect();
    }
  }
}
