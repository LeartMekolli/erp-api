import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { UnitsService, createUnitSchema, unitResponseSchema } from './units';
import type { UnitResponse } from './units';

/** Units of measure (spec C7): the seeded ones plus the tenant's own. */
@Controller('catalog/units')
export class UnitsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
  ) {}

  @ApiDoc({
    summary: 'Every unit the workspace can use: the seeded ones and its own.',
    description: 'Each unit has a dimension and its factor to the base unit of that dimension (g, mm3, mm2, mm, piece).',
    response: z.strictObject({ data: z.array(unitResponseSchema) }),
  })
  @RequirePermission('catalog.read')
  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<{ data: UnitResponse[] }> {
    return { data: await this.prisma.inTenant(tenantId, (tx) => this.units.all(tx)) };
  }

  @ApiDoc({
    summary: 'Add a unit within one of the fixed dimensions.',
    description: 'The factor is how many base units one of this unit is, for example 1.55517384 g for a pennyweight. A key already in use is a 409.',
    body: createUnitSchema,
    response: unitResponseSchema,
    errors: [400],
  })
  @RequirePermission('catalog.write')
  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createUnitSchema)) body: z.infer<typeof createUnitSchema>,
  ): Promise<UnitResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.units.create(tx, body));
  }
}
