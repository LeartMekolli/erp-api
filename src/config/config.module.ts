import { Global, Module } from '@nestjs/common';
import { ConfigService, createConfigService } from './config.service';

/**
 * Global so no module has to import it to read configuration. The factory is
 * the single call site of `createConfigService`, which is the single reader of
 * `process.env` — an invalid environment therefore fails at boot, here.
 */
@Global()
@Module({
  providers: [{ provide: ConfigService, useFactory: () => createConfigService() }],
  exports: [ConfigService],
})
export class ConfigModule {}
