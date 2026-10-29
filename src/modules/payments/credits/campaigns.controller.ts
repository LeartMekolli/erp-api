import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import { CampaignsService } from './campaigns.service';
import { campaignListResponseSchema, campaignResponseSchema, createCampaignSchema, updateCampaignSchema } from './credit-response';
import type { CampaignListResponse, CampaignResponse, CreateCampaign, UpdateCampaign } from './credit-response';

const idParam = new ZodValidationPipe(z.uuid());

/** Campaigns (Payments 2 spec, goal 11): free credits given automatically, within a budget. Staff only. */
@Controller('payments/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @ApiDoc({
    summary: 'Every campaign of the workspace, newest first, with what it granted and what was spent of it.',
    response: campaignListResponseSchema,
  })
  @RequirePermission('payment.read')
  @Get()
  list(@CurrentTenant() tenantId: string): Promise<CampaignListResponse> {
    return this.campaigns.list(tenantId);
  }

  @ApiDoc({
    summary: 'One campaign, with what it granted and what was spent of it.',
    response: campaignResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('payment.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<CampaignResponse> {
    return this.campaigns.get(tenantId, id);
  }

  @ApiDoc({
    summary: 'Create a campaign as a draft: credits per customer for the plans and customers it targets, within a budget.',
    description: 'Nothing is granted until it is activated. Each customer gets its credits once; a grant is never split.',
    body: createCampaignSchema,
    response: campaignResponseSchema,
    errors: [400],
  })
  @RequirePermission('plan.write')
  @Post()
  create(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaign): Promise<CampaignResponse> {
    return this.campaigns.create(auth, body);
  }

  @ApiDoc({
    summary: 'Change a draft or paused campaign; `targets`, when sent, replaces them all.',
    description: 'A running or ended campaign is a 409: pause it first.',
    body: updateCampaignSchema,
    response: campaignResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('plan.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCampaignSchema)) body: UpdateCampaign,
  ): Promise<CampaignResponse> {
    return this.campaigns.update(auth, id, body);
  }

  @ApiDoc({
    summary: 'Start or resume a campaign, granting at once to every customer it targets now.',
    description: 'Customers who join a targeted plan later get their credits then. An ended campaign is a 409.',
    response: campaignResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('plan.write')
  @Post(':id/activate')
  @HttpCode(200)
  activate(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<CampaignResponse> {
    return this.campaigns.activate(auth, id);
  }

  @ApiDoc({
    summary: 'Stop a campaign granting for now; the credits it gave stay until they expire.',
    response: campaignResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('plan.write')
  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<CampaignResponse> {
    return this.campaigns.pause(auth, id);
  }

  @ApiDoc({
    summary: 'End a campaign for good; the credits it gave stay until they expire.',
    response: campaignResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('plan.write')
  @Post(':id/end')
  @HttpCode(200)
  end(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<CampaignResponse> {
    return this.campaigns.end(auth, id);
  }
}
