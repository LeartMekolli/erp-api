import { Inject, Injectable, LoggerService } from '@nestjs/common';
import type { Level, Logger } from 'pino';
import { LOGGER } from './logger';

/**
 * Routes Nest's own logging (bootstrap, `new Logger(...)` in services) into
 * the same JSON stream. Nest passes the context name as the last string
 * argument, and for `error` a stack before it.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    const strings = rest.filter((part): part is string => typeof part === 'string');
    const context = strings.at(-1);
    const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;

    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ context, ...message });
    } else {
      this.logger[level]({ context, stack }, String(message));
    }
  }
}
