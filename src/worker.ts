import { NestFactory } from '@nestjs/core';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // An application context, not an application: the worker serves no HTTP.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLoggerService));
  // SIGTERM and SIGINT close the workers, which wait for active jobs.
  app.enableShutdownHooks();
}
void bootstrap();
