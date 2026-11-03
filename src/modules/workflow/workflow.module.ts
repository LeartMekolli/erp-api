import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { DefectsController } from './defects.controller';
import { DefectsService } from './defects.service';
import { MovesService } from './moves.service';
import { PlanningController } from './planning/planning.controller';
import { PlanningService } from './planning/planning.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Workflows, work orders and the QC log: how each piece moves through production (Workflow/QC spec), and
 * the day's plan per in-house step type (Orders 3 spec).
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [DefectsController, WorkflowsController, WorkOrdersController, PlanningController],
  providers: [DefectsService, MovesService, WorkflowsService, WorkOrdersService, PlanningService],
  exports: [WorkOrdersService, MovesService],
})
export class WorkflowModule {}
