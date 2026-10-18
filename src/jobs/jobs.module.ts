import { Global, Module } from '@nestjs/common';
import { ClaimSweeper } from './claim-sweeper';
import { JobsService } from './jobs.service';
import { RedisLock } from './redis-lock';
import { DEFAULT_JOB_REGISTRY, JOB_REGISTRY } from './registry';

@Global()
@Module({
  providers: [{ provide: JOB_REGISTRY, useValue: DEFAULT_JOB_REGISTRY }, JobsService, RedisLock, ClaimSweeper],
  exports: [JobsService, JOB_REGISTRY, RedisLock, ClaimSweeper],
})
export class JobsModule {}
