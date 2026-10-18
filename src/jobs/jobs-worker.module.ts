import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ClaimSweepHandler } from './claim-sweeper';
import { JobsWorker } from './jobs-worker';

/** Consumers. Imported by `WorkerModule` only, never by `AppModule`. */
@Module({ imports: [DiscoveryModule], providers: [JobsWorker, ClaimSweepHandler] })
export class JobsWorkerModule {}
