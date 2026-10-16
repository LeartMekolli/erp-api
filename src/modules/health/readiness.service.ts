import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';

export interface Readiness {
  status: 'ok' | 'error';
  checks: { database: boolean; redis: boolean };
}

@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Never rejects: an orchestrator needs an answer, and a probe that throws
   * cannot distinguish "still starting" from "crashed". Both dependencies are
   * checked in parallel, so one being down never hides the other's state.
   */
  async check(): Promise<Readiness> {
    const [database, redis] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1 as one`.then(() => true)
        .catch(() => false),
      this.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    return {
      status: database && redis ? 'ok' : 'error',
      checks: { database, redis },
    };
  }
}
