import { ReadinessService } from './readiness.service';

const reachableDatabase = { $queryRaw: jest.fn().mockResolvedValue([{ one: 1 }]) };
const reachableRedis = { ping: jest.fn().mockResolvedValue('PONG') };

describe('ReadinessService', () => {
  it('is ready when both dependencies answer', async () => {
    const service = new ReadinessService(reachableDatabase as never, reachableRedis as never);

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { database: true, redis: true },
    });
  });

  it('reports not ready when the database is unreachable, without rejecting', async () => {
    const service = new ReadinessService(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never,
      reachableRedis as never,
    );

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      checks: { database: false, redis: true },
    });
  });

  it('reports not ready when redis is unreachable, without rejecting', async () => {
    const service = new ReadinessService(reachableDatabase as never, {
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      checks: { database: true, redis: false },
    });
  });

  it('checks both dependencies even when the first one fails', async () => {
    const redis = { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const service = new ReadinessService(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never,
      redis as never,
    );

    const result = await service.check();

    expect(result.checks).toEqual({ database: false, redis: false });
    expect(redis.ping).toHaveBeenCalled();
  });
});
