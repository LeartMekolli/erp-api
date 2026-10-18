import type { ConnectionOptions } from 'bullmq';
import { ConfigService } from '../config/config.service';

/**
 * BullMQ is handed plain options, not an ioredis instance: it creates and owns
 * its connections, which avoids a type clash between ioredis versions.
 */
function fromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/**
 * Producer options for the web process: bounded retries, so an enqueue against
 * an unreachable Redis fails fast instead of hanging a request.
 */
export function createProducerConnection(config: ConfigService): ConnectionOptions {
  return {
    ...fromUrl(config.get('REDIS_URL')),
    maxRetriesPerRequest: 2,
    connectTimeout: 2000,
  };
}

/**
 * Worker options: BullMQ requires `maxRetriesPerRequest: null` because workers
 * block on commands and must wait out a Redis outage, not fail.
 */
export function createWorkerConnection(config: ConfigService): ConnectionOptions {
  return { ...fromUrl(config.get('REDIS_URL')), maxRetriesPerRequest: null };
}
