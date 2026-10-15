import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiErrorFilter } from './api-error.filter';

/**
 * Importing this module is what gives an application the single error shape.
 * Registering through `APP_FILTER` rather than `app.useGlobalFilters(...)` keeps
 * the filter injectable and makes it apply under test as well as in `main.ts`.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class ErrorsModule {}
