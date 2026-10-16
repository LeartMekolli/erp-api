import { Global, Module } from '@nestjs/common';
import pino from 'pino';
import { ConfigService } from '../../config/config.service';
import { LOG_DESTINATION, LOGGER, createLogger } from './logger';
import { PinoLoggerService } from './pino-logger.service';

export { LOG_DESTINATION, LOGGER } from './logger';

/** The destination is a provider so tests can capture output in memory. */
@Global()
@Module({
  providers: [
    { provide: LOG_DESTINATION, useFactory: () => pino.destination(1) },
    { provide: LOGGER, inject: [ConfigService, LOG_DESTINATION], useFactory: createLogger },
    PinoLoggerService,
  ],
  exports: [LOGGER, PinoLoggerService],
})
export class LoggingModule {}
