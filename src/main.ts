import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ConfigService, createConfigService } from './config/config.service';

async function bootstrap() {
  // The module graph is chosen before Nest starts, so the flag is read here,
  // through the config module, rather than from inside a provider.
  const withWorker = createConfigService().get('WORKER_IN_PROCESS');
  // Buffered until configureApp installs the JSON logger, so boot messages are
  // not printed in Nest's plain-text format first.
  const app = await NestFactory.create(AppModule.register({ withWorker }), { bufferLogs: true });
  configureApp(app);
  await app.listen(app.get(ConfigService).get('PORT'));
}
void bootstrap();
