import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { MeasureHandler } from './measure.handler';
import { DEFAULT_MEASURERS, MEASURERS } from './measurers';

/**
 * Spec section 5. Imported by both processes: the API signs uploads and
 * downloads and completes versions; the worker runs the measurement job.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [FilesController],
  providers: [FilesService, MeasureHandler, { provide: MEASURERS, useValue: DEFAULT_MEASURERS }],
  exports: [FilesService],
})
export class FilesModule {}
