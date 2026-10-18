import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { DEFAULT_JOB_REGISTRY, JOB_REGISTRY } from './registry';

@Global()
@Module({
  providers: [{ provide: JOB_REGISTRY, useValue: DEFAULT_JOB_REGISTRY }, JobsService],
  exports: [JobsService, JOB_REGISTRY],
})
export class JobsModule {}
