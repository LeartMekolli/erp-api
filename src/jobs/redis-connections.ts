import type { ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { ConfigService } from '../config/config.service';

/** Plain options for a URL; the shared clients below are built from them. */
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

/**
 * One client shared by every queue of a process, and one by every worker. Hosted Redis plans count
 * connections and a deploy runs two processes side by side, so a connection per queue adds up; only
 * each worker's blocking connection, which BullMQ opens itself, is per queue. BullMQ never closes a
 * client it was given: the owner quits it after the queues or workers have closed.
 */
export function createSharedClient(config: ConfigService, role: 'producer' | 'worker'): Redis {
  const options = role === 'producer' ? createProducerConnection(config) : createWorkerConnection(config);
  return new Redis({ ...(options as RedisOptions), connectionName: `${config.get('QUEUE_PREFIX')}:jobs:${role}` });
}

/** Quits a shared client, or drops its socket when it never connected. */
export async function closeSharedClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
