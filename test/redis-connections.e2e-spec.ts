import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { QUEUES } from '../src/jobs/registry';
import { RedisService } from '../src/redis/redis.service';
import { startTestWorker } from './worker-harness';

/**
 * Hosted Redis plans count connections (staging's allows 30), and a deploy runs the old and the new
 * process side by side. The jobs code shares one connection for sending jobs and one for the workers,
 * so only each worker's blocking connection grows with the number of queues.
 */
describe('redis connections', () => {
  let app: INestApplication;
  let worker: TestingModule;
  const prefix = `t${randomBytes(6).toString('hex')}`;
  const previousPrefix = process.env.QUEUE_PREFIX;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = prefix;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  /** The names of this spec's job connections, as Redis lists its clients. */
  async function jobConnections(): Promise<string[]> {
    const list = (await app.get(RedisService).client.call('CLIENT', 'LIST')) as string;
    return list
      .split('\n')
      .map((line) => /(?:^| )name=(\S*)/.exec(line)?.[1] ?? '')
      .filter((name) => name.startsWith(`${prefix}:`));
  }

  it('sends jobs over one shared connection per process', async () => {
    const names = await jobConnections();

    // The API's and the worker's: each process sends jobs.
    expect(names.filter((name) => name === `${prefix}:jobs:producer`)).toHaveLength(2);
  });

  it('holds one connection per queue for blocking, plus the shared ones', async () => {
    const names = await jobConnections();

    // Two producers, the workers' shared connection, and one blocking connection per queue.
    expect(names.length).toBeLessThanOrEqual(QUEUES.length + 3);
  });
});
