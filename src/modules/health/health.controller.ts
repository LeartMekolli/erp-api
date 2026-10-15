import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
