import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ClaimSweepHandler } from './claim-sweeper';
import { JobsWorker } from './jobs-worker';

/** Consumers. Imported by `WorkerModule`, and by the API only when WORKER_IN_PROCESS is on (`AppModule.register`). */
@Module({ imports: [DiscoveryModule], providers: [JobsWorker, ClaimSweepHandler] })
export class JobsWorkerModule {}
