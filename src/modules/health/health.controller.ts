import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiDoc } from '../../docs/api-doc';
import { Public } from '../identity/route-markers';
import type { Readiness } from './readiness.service';
import { ReadinessService } from './readiness.service';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  @ApiDoc({ summary: 'Liveness: answers while the process is up, without touching any dependency.' })
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: the process can serve traffic. 503 when a dependency is
   * unreachable, so an orchestrator stops routing to it without killing it.
   */
  @ApiDoc({
    summary: 'Readiness: whether the database and Redis are reachable.',
    description: 'Answers 503, with the same body, when either is down.',
  })
  @Public()
  @Get('ready')
  async ready(@Res() response: Response<Readiness>): Promise<void> {
    const readiness = await this.readiness.check();
    response.status(readiness.status === 'ok' ? 200 : 503).json(readiness);
  }
}
