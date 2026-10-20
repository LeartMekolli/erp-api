import { randomInt } from 'node:crypto';
import { Controller, Get, INestApplication, Ip } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService, createConfigService } from '../src/config/config.service';
import { Public } from '../src/modules/identity/route-markers';
import { RedisService } from '../src/redis/redis.service';

@Controller('test-ip')
class IpEchoController {
  @Public()
  @Get()
  ip(@Ip() ip: string): { ip: string } {
    return { ip };
  }
}

describe('trust proxy', () => {
  const apps: INestApplication[] = [];
  const touchedKeys: string[] = [];
  let redis: RedisService;

  async function boot(hops: number): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [IpEchoController] })
      .overrideProvider(ConfigService)
      .useValue(createConfigService({ ...process.env, TRUST_PROXY_HOPS: String(hops) }))
      .compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    apps.push(app);
    redis = moduleRef.get(RedisService);
    return app;
  }

  const forwarded = '198.51.100.7, 203.0.113.9';
  const echoedIp = async (app: INestApplication, header: string): Promise<string> => {
    const response = await request(app.getHttpServer()).get('/test-ip').set('X-Forwarded-For', header).expect(200);
    return (response.body as { ip: string }).ip;
  };

  afterAll(async () => {
    if (touchedKeys.length > 0) {
      await redis.client.del(...touchedKeys);
    }
    await Promise.all(apps.map((app) => app.close()));
  });

  it('ignores a forged X-Forwarded-For when no hops are trusted', async () => {
    const app = await boot(0);

    expect(await echoedIp(app, forwarded)).toMatch(/127\.0\.0\.1$/);
  });

  it('with one hop, the client is the last address the proxy appended', async () => {
    const app = await boot(1);

    expect(await echoedIp(app, forwarded)).toBe('203.0.113.9');
  });

  it('with two hops, the client is the one before it', async () => {
    const app = await boot(2);

    expect(await echoedIp(app, forwarded)).toBe('198.51.100.7');
  });

  it('keeps separate password-reset counters for two forwarded addresses when one hop is trusted', async () => {
    const app = await boot(1);
    const a = `203.0.113.${randomInt(1, 250)}`;
    const b = `198.51.100.${randomInt(1, 250)}`;
    touchedKeys.push(`ratelimit:reset-ip:${a}`, `ratelimit:reset-ip:${b}`);
    const reset = (ip: string) =>
      request(app.getHttpServer())
        .post('/auth/password-reset')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@example.test', workspace: 'no-such-tenant' })
        .expect(202);

    await reset(a);
    await reset(a);
    await reset(b);

    // Read back from the counters themselves: sending enough requests to hit
    // the limit would race the password-reset spec, which clears every counter.
    expect(await redis.client.get(`ratelimit:reset-ip:${a}`)).toBe('2');
    expect(await redis.client.get(`ratelimit:reset-ip:${b}`)).toBe('1');
  });
});
