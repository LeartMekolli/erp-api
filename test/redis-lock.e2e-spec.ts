import { TestingModule, Test } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { RedisLock } from '../src/jobs/redis-lock';
import { RedisModule } from '../src/redis/redis.module';
import { RedisService } from '../src/redis/redis.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('redis lock', () => {
  let moduleRef: TestingModule;
  let lock: RedisLock;
  let redis: RedisService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedisModule],
      providers: [RedisLock],
    }).compile();
    lock = moduleRef.get(RedisLock);
    redis = moduleRef.get(RedisService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('two concurrent runs: exactly one acquires', async () => {
    const name = `test:${newId()}`;
    const results = await Promise.all([
      lock.run(name, 5000, () => sleep(100).then(() => 'a')),
      lock.run(name, 5000, () => sleep(100).then(() => 'b')),
    ]);

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it('the lock frees after the run, and after its TTL if the holder dies', async () => {
    const name = `test:${newId()}`;
    expect(await lock.run(name, 5000, () => Promise.resolve(1))).toEqual({ acquired: true, value: 1 });
    expect(await lock.run(name, 5000, () => Promise.resolve(2))).toEqual({ acquired: true, value: 2 });

    // A holder that died without releasing: only its TTL frees the lock.
    await redis.client.set(`lock:${name}`, 'dead-holder', 'PX', 150);
    expect(await lock.run(name, 5000, () => Promise.resolve(3))).toEqual({ acquired: false });
    await sleep(200);
    expect(await lock.run(name, 5000, () => Promise.resolve(4))).toEqual({ acquired: true, value: 4 });
  });

  it("a holder whose lock expired does not release the next holder's lock", async () => {
    const name = `test:${newId()}`;

    // A holds a 50 ms lock but works for 200 ms; B takes over once it expires.
    const first = lock.run(name, 50, () => sleep(200));
    await sleep(100);
    const second = lock.run(name, 5000, () => sleep(300));
    await first;

    // A finished and released; B's lock must still be in place.
    expect(await lock.run(name, 5000, () => Promise.resolve('third'))).toEqual({ acquired: false });
    expect(await second).toEqual({ acquired: true, value: undefined });
  });
});
