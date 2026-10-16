import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { Readiness, ReadinessService } from './readiness.service';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: the process can serve traffic. 503 when a dependency is
   * unreachable, so an orchestrator stops routing to it without killing it.
   */
  @Get('ready')
  async ready(@Res() response: Response<Readiness>): Promise<void> {
    const readiness = await this.readiness.check();
    response.status(readiness.status === 'ok' ? 200 : 503).json(readiness);
  }
}
