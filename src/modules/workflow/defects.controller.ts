import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { DefectsService, createDefectSchema, updateDefectSchema } from './defects.service';
import { defectResponseSchema } from './workflow-response';
import type { DefectResponse } from './workflow-response';

const idSchema = z.uuid();

/** The defect catalogue: failure reasons staff record when a piece fails a check (D38). */
@Controller('workflow/defects')
export class DefectsController {
  constructor(private readonly defects: DefectsService) {}

  @ApiDoc({
    summary: 'Add a defect to the catalogue, a failure reason staff can record when a piece fails a check.',
    description: 'A key already in use is a 409. Defects are never deleted, since past transitions point at them.',
    body: createDefectSchema,
    response: defectResponseSchema,
    errors: [400],
  })
  @RequirePermission('workflow.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createDefectSchema)) body: z.infer<typeof createDefectSchema>,
  ): Promise<DefectResponse> {
    return this.defects.create(auth, body);
  }

  @ApiDoc({
    summary: 'Every defect in the catalogue, active or not, by key.',
    response: z.strictObject({ data: z.array(defectResponseSchema) }),
  })
  @RequirePermission('workflow.read')
  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<{ data: DefectResponse[] }> {
    return { data: await this.defects.list(tenantId) };
  }

  @ApiDoc({
    summary: "Rename a defect, or deactivate it so it can't be added to workflow steps any more.",
    body: updateDefectSchema,
    response: defectResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('workflow.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateDefectSchema)) body: z.infer<typeof updateDefectSchema>,
  ): Promise<DefectResponse> {
    return this.defects.update(auth, id, body);
  }
}
