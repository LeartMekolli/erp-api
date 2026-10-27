import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiDoc } from '../../docs/api-doc';
import { Public } from '../identity/route-markers';
import { PaymentEventsService } from './payment-events.service';
import { webhookAckResponseSchema } from './payment-response';
import type { WebhookAckResponse } from './payment-response';

/** `configureApp` gives these routes the raw body, as a Buffer; the signature covers those bytes. */
const rawBody = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

const DESCRIPTION =
  "Called by the payment provider, not by clients. The body is the provider's event, checked against the " +
  "`Stripe-Signature` header with this endpoint's signing secret. Each event is stored once and applied by a job; " +
  'a repeat answers 200 and changes nothing. An unknown or suspended workspace answers 404; a workspace without ' +
  'keys, or a missing or wrong signature, answers 400.';

/** Payment provider webhooks, one pair per workspace (Payments spec, goal 10). */
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly events: PaymentEventsService) {}

  @ApiDoc({
    summary: "Receive an event from the workspace's payment account.",
    description: DESCRIPTION,
    response: webhookAckResponseSchema,
    errors: [400, 404],
  })
  @Public()
  @Post(':tenantId')
  @HttpCode(200)
  payments(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<WebhookAckResponse> {
    return this.events.receive(tenantId, 'payments', rawBody(req), signature);
  }

  @ApiDoc({
    summary: "Receive an event from a partner's connected account.",
    description: DESCRIPTION,
    response: webhookAckResponseSchema,
    errors: [400, 404],
  })
  @Public()
  @Post(':tenantId/connect')
  @HttpCode(200)
  connect(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<WebhookAckResponse> {
    return this.events.receive(tenantId, 'connect', rawBody(req), signature);
  }
}
