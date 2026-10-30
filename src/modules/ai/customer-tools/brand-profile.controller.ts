import { Body, Controller, Get, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer } from '../../identity/auth-context';
import type { CustomerAuth } from '../../identity/auth-context';
import { CustomerAccess } from '../../identity/route-markers';
import { brandProfileBodySchema, brandProfileSchema } from './brand-profile-response';
import type { BrandProfileBody, BrandProfileResponse } from './brand-profile-response';
import { BrandProfileService } from './brand-profile.service';

/** The customer's brand profile, read by its AI tools (AI 2 spec, goals 8–9). */
@Controller('portal/customers/:customerId/ai/brand-profile')
export class BrandProfileController {
  constructor(private readonly profiles: BrandProfileService) {}

  @ApiDoc({
    summary: "The customer's brand profile: name, what it sells, to whom, its tone and notes.",
    description: 'A 404 until someone saves one.',
    response: brandProfileSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get()
  get(@CurrentCustomer() customer: CustomerAuth): Promise<BrandProfileResponse> {
    return this.profiles.get(customer);
  }

  @ApiDoc({
    summary: "Save the customer's brand profile, replacing it whole.",
    description: 'Free. The AI tools read it as context; brand content needs it.',
    body: brandProfileBodySchema,
    response: brandProfileSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Put()
  save(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(brandProfileBodySchema)) body: BrandProfileBody,
  ): Promise<BrandProfileResponse> {
    return this.profiles.save(customer, body);
  }
}
