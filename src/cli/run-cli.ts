import 'reflect-metadata';
import { INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ZodError, z } from 'zod';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PlatformModule } from '../platform/platform.module';

/** What command-line tasks need: no HTTP server, no Redis. */
@Module({ imports: [ConfigModule, DatabaseModule, PlatformModule] })
export class CliModule {}

function formatError(error: unknown): string {
  if (error instanceof ZodError) {
    return z.prettifyError(error);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Boots the CLI context, runs the task, and always closes the context so the
 * database pool does not keep the process alive. Failures print a readable
 * message and set a non-zero exit code.
 */
export async function runCli(task: (app: INestApplicationContext) => Promise<void>): Promise<void> {
  try {
    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
      await task(app);
    } finally {
      await app.close();
    }
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}
