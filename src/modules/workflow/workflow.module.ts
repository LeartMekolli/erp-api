import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DefectsController } from './defects.controller';
import { DefectsService } from './defects.service';
import { MovesService } from './moves.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/** Workflows, work orders and the QC log: how each piece moves through production (Workflow/QC spec). */
@Module({
  imports: [AuditModule],
  controllers: [DefectsController, WorkflowsController, WorkOrdersController],
  providers: [DefectsService, MovesService, WorkflowsService, WorkOrdersService],
  exports: [WorkOrdersService],
})
export class WorkflowModule {}
