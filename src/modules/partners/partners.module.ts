import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

/** Partner workshops, their people, setup and jobs (Partners spec). */
@Module({
  imports: [AuditModule],
  controllers: [PartnersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
