import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [AuditModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
