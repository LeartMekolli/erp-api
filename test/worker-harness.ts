import type { Provider } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { WorkerModule } from '../src/worker.module';

/**
 * Boots the worker in-process, as `worker.ts` does, against the real Redis
 * and Postgres. `providers` adds fixture job handlers; `overrides` swaps
 * providers such as the job registry, the mailer or the log destination.
 * Set `QUEUE_PREFIX` before calling, so specs never consume each other's jobs.
 */
export async function startTestWorker(
  overrides: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
  providers: Provider[] = [],
): Promise<TestingModule> {
  const moduleRef = await overrides(
    Test.createTestingModule({ imports: [WorkerModule], providers }),
  ).compile();
  try {
    await moduleRef.init();
  } catch (error) {
    // A refused boot still opened queue connections; close them so the spec
    // does not leave handles behind.
    await moduleRef.close();
    throw error;
  }
  return moduleRef;
}
