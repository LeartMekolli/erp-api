import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import {
  AdjustmentsService,
  createCustomerGroupSchema,
  createDeliverySpeedSchema,
  createMinSizeSurchargeSchema,
  discountTiersSchema,
  marginSchema,
  updateCustomerGroupSchema,
  updateDeliverySpeedSchema,
} from './adjustments.service';
import {
  customerGroupResponseSchema,
  deliverySpeedResponseSchema,
  discountTiersResponseSchema,
  marginOverrideResponseSchema,
  minSizeSurchargeResponseSchema,
} from './pricing-response';
import type {
  CustomerGroupResponse,
  DeliverySpeedResponse,
  DiscountTiersResponse,
  MarginOverrideResponse,
  MinSizeSurchargeResponse,
} from './pricing-response';

const idSchema = z.uuid();
const idParam = new ZodValidationPipe(idSchema);

/** What the engine applies after step costs: margins, discounts, groups, speeds, small-part surcharges (Pricing spec). */
@Controller('pricing')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @ApiDoc({
    summary: "Give a category its own margin instead of the pricing profile's.",
    description: "A product's own margin wins over its category's.",
    body: marginSchema,
    response: marginOverrideResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('categories/:id/margin')
  setCategoryMargin(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(marginSchema)) body: z.infer<typeof marginSchema>,
  ): Promise<MarginOverrideResponse> {
    return this.adjustments.setMargin(auth, 'category', id, body);
  }

  @ApiDoc({ summary: "Return a category to the pricing profile's margin.", errors: [400, 404] })
  @RequirePermission('pricing.write')
  @Delete('categories/:id/margin')
  @HttpCode(204)
  async clearCategoryMargin(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<void> {
    await this.adjustments.clearMargin(auth, 'category', id);
  }

  @ApiDoc({
    summary: "Give a product its own margin instead of its category's or the pricing profile's.",
    body: marginSchema,
    response: marginOverrideResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Put('products/:id/margin')
  setProductMargin(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(marginSchema)) body: z.infer<typeof marginSchema>,
  ): Promise<MarginOverrideResponse> {
    return this.adjustments.setMargin(auth, 'product', id, body);
  }

  @ApiDoc({ summary: "Return a product to its category's or the pricing profile's margin.", errors: [400, 404] })
  @RequirePermission('pricing.write')
  @Delete('products/:id/margin')
  @HttpCode(204)
  async clearProductMargin(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<void> {
    await this.adjustments.clearMargin(auth, 'product', id);
  }

  @ApiDoc({ summary: 'The quantity discount tiers, lowest quantity first.', response: discountTiersResponseSchema })
  @RequirePermission('pricing.read')
  @Get('discount-tiers')
  tiers(@CurrentTenant() tenantId: string): Promise<DiscountTiersResponse> {
    return this.adjustments.tiers(tenantId);
  }

  @ApiDoc({
    summary: 'Replace the quantity discount tiers.',
    description: 'From `min_quantity` pieces on, `percent` off; the highest tier reached applies. An empty list removes them.',
    body: discountTiersSchema,
    response: discountTiersResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Put('discount-tiers')
  setTiers(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(discountTiersSchema)) body: z.infer<typeof discountTiersSchema>,
  ): Promise<DiscountTiersResponse> {
    return this.adjustments.setTiers(auth, body);
  }

  @ApiDoc({
    summary: 'Every customer group, by key.',
    response: z.strictObject({ data: z.array(customerGroupResponseSchema) }),
  })
  @RequirePermission('pricing.read')
  @Get('customer-groups')
  async groups(@CurrentTenant() tenantId: string): Promise<{ data: CustomerGroupResponse[] }> {
    return { data: await this.adjustments.groups(tenantId) };
  }

  @ApiDoc({
    summary: 'Create a customer group with a markup or discount.',
    description: '`percent` from -50 (a discount) to 100 (a markup). A key already in use is a 409.',
    body: createCustomerGroupSchema,
    response: customerGroupResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Post('customer-groups')
  createGroup(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createCustomerGroupSchema)) body: z.infer<typeof createCustomerGroupSchema>,
  ): Promise<CustomerGroupResponse> {
    return this.adjustments.createGroup(auth, body);
  }

  @ApiDoc({
    summary: "Change a customer group's name or percent.",
    body: updateCustomerGroupSchema,
    response: customerGroupResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Patch('customer-groups/:id')
  updateGroup(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCustomerGroupSchema)) body: z.infer<typeof updateCustomerGroupSchema>,
  ): Promise<CustomerGroupResponse> {
    return this.adjustments.updateGroup(auth, id, body);
  }

  @ApiDoc({
    summary: 'Every delivery speed, by key.',
    response: z.strictObject({ data: z.array(deliverySpeedResponseSchema) }),
  })
  @RequirePermission('pricing.read')
  @Get('delivery-speeds')
  async speeds(@CurrentTenant() tenantId: string): Promise<{ data: DeliverySpeedResponse[] }> {
    return { data: await this.adjustments.speeds(tenantId) };
  }

  @ApiDoc({
    summary: 'Create a delivery speed with a surcharge.',
    description:
      'At most one speed is the default; making a second one the default is a 409, so unset the old one first. ' +
      'A key already in use is a 409.',
    body: createDeliverySpeedSchema,
    response: deliverySpeedResponseSchema,
    errors: [400],
  })
  @RequirePermission('pricing.write')
  @Post('delivery-speeds')
  createSpeed(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createDeliverySpeedSchema)) body: z.infer<typeof createDeliverySpeedSchema>,
  ): Promise<DeliverySpeedResponse> {
    return this.adjustments.createSpeed(auth, body);
  }

  @ApiDoc({
    summary: "Change a delivery speed's name, surcharge or whether it is the default.",
    description: 'Making it the default while another speed is the default is a 409.',
    body: updateDeliverySpeedSchema,
    response: deliverySpeedResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('pricing.write')
  @Patch('delivery-speeds/:id')
  updateSpeed(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateDeliverySpeedSchema)) body: z.infer<typeof updateDeliverySpeedSchema>,
  ): Promise<DeliverySpeedResponse> {
    return this.adjustments.updateSpeed(auth, id, body);
  }

  @ApiDoc({
    summary: 'Every minimum-size surcharge.',
    response: z.strictObject({ data: z.array(minSizeSurchargeResponseSchema) }),
  })
  @RequirePermission('pricing.read')
  @Get('min-size-surcharges')
  async surcharges(@CurrentTenant() tenantId: string): Promise<{ data: MinSizeSurchargeResponse[] }> {
    return { data: await this.adjustments.surcharges(tenantId) };
  }

  @ApiDoc({
    summary: 'Add a surcharge per piece for designs smaller than a minimum size.',
    description:
      'Applies when the scaled design measures below `below` `unit` (a unit of the measure, such as cm3 for ' +
      'volume). Without `category_id` it applies to every category.',
    body: createMinSizeSurchargeSchema,
    response: minSizeSurchargeResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('pricing.write')
  @Post('min-size-surcharges')
  createSurcharge(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createMinSizeSurchargeSchema)) body: z.infer<typeof createMinSizeSurchargeSchema>,
  ): Promise<MinSizeSurchargeResponse> {
    return this.adjustments.createSurcharge(auth, body);
  }

  @ApiDoc({ summary: 'Delete a minimum-size surcharge.', errors: [400, 404] })
  @RequirePermission('pricing.write')
  @Delete('min-size-surcharges/:id')
  @HttpCode(204)
  async removeSurcharge(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<void> {
    await this.adjustments.removeSurcharge(auth, id);
  }
}
