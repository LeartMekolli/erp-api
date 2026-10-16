import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  // Buffered until configureApp installs the JSON logger, so boot messages are
  // not printed in Nest's plain-text format first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  await app.listen(app.get(ConfigService).get('PORT'));
}
void bootstrap();
