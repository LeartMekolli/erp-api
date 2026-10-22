import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { optionGroupResponseSchema, optionRuleResponseSchema, optionValueResponseSchema } from './option-response';
import type { OptionGroupResponse, OptionRuleResponse, OptionValueResponse } from './option-response';
import { OptionsService, createGroupSchema, createRuleSchema, createValueSchema, updateValueSchema } from './options.service';

const idSchema = z.uuid();

/** Option groups, values and rules (Catalog spec C4, B9). */
@Controller('catalog')
export class OptionsController {
  constructor(private readonly options: OptionsService) {}

  @ApiDoc({
    summary: 'Create an option group, such as material or finish.',
    description: 'A key already in use is a 409.',
    body: createGroupSchema,
    response: optionGroupResponseSchema,
    errors: [400],
  })
  @RequirePermission('catalog.write')
  @Post('option-groups')
  createGroup(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createGroupSchema)) body: z.infer<typeof createGroupSchema>,
  ): Promise<OptionGroupResponse> {
    return this.options.createGroup(tenantId, body);
  }

  @ApiDoc({
    summary: 'Every option group with its values.',
    response: z.strictObject({ data: z.array(optionGroupResponseSchema) }),
  })
  @RequirePermission('catalog.read')
  @Get('option-groups')
  async listGroups(@CurrentTenant() tenantId: string): Promise<{ data: OptionGroupResponse[] }> {
    return { data: await this.options.listGroups(tenantId) };
  }

  @ApiDoc({
    summary: 'Add a value to an option group, optionally selecting a material.',
    description: 'Choosing a value with a `material_id` selects that material. A key already in the group is a 409.',
    body: createValueSchema,
    response: optionValueResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Post('option-groups/:id/values')
  createValue(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) groupId: string,
    @Body(new ZodValidationPipe(createValueSchema)) body: z.infer<typeof createValueSchema>,
  ): Promise<OptionValueResponse> {
    return this.options.createValue(tenantId, groupId, body);
  }

  @ApiDoc({
    summary: 'Rename an option value, or change or clear the material it selects.',
    body: updateValueSchema,
    response: optionValueResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Patch('option-values/:id')
  updateValue(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateValueSchema)) body: z.infer<typeof updateValueSchema>,
  ): Promise<OptionValueResponse> {
    return this.options.updateValue(tenantId, id, body);
  }

  @ApiDoc({
    summary: 'Create a rule between option values.',
    description:
      '`excludes`: choosing the value rules out every target. `requires`: choosing the value needs at least one of ' +
      'the targets. Targets may come from any group.',
    body: createRuleSchema,
    response: optionRuleResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.write')
  @Post('option-rules')
  createRule(
    @CurrentTenant() tenantId: string,
    @Body(new ZodValidationPipe(createRuleSchema)) body: z.infer<typeof createRuleSchema>,
  ): Promise<OptionRuleResponse> {
    return this.options.createRule(tenantId, body);
  }

  @ApiDoc({
    summary: 'Every option rule.',
    response: z.strictObject({ data: z.array(optionRuleResponseSchema) }),
  })
  @RequirePermission('catalog.read')
  @Get('option-rules')
  async listRules(@CurrentTenant() tenantId: string): Promise<{ data: OptionRuleResponse[] }> {
    return { data: await this.options.listRules(tenantId) };
  }

  @ApiDoc({ summary: 'Delete an option rule.', errors: [400, 404] })
  @RequirePermission('catalog.write')
  @Delete('option-rules/:id')
  @HttpCode(204)
  async deleteRule(@CurrentTenant() tenantId: string, @Param('id', new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.options.deleteRule(tenantId, id);
  }
}
