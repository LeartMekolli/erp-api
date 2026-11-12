import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { downloadUrlResponseSchema } from '../files/file-response';
import { CurrentPartner } from '../identity/auth-context';
import type { PartnerAuth } from '../identity/auth-context';
import { PartnerAccess } from '../identity/route-markers';
import { moveHistoryQuerySchema } from '../workflow/move-history';
import type { MoveHistoryQuery } from '../workflow/move-history';
import { JobMovesService } from './job-moves.service';
import { partnerMoveHistoryResponseSchema } from './partner-response';
import type { PartnerMoveHistoryResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * The moves on a job a partner holds (Move history spec): every move on its pieces, before and after the
 * hand-over, with names and free text only on its own people's moves.
 */
@Controller('partner-portal/partners/:partnerId/jobs/:groupId/moves')
export class JobMovesController {
  constructor(private readonly moves: JobMovesService) {}

  @ApiDoc({
    summary: "The moves on one of the partner's jobs, one item per action, newest first, a page at a time.",
    description:
      "Only for a job the partner has accepted and still holds; else a 404. Names and what was written show only on moves the partner's own people made.",
    query: moveHistoryQuerySchema,
    response: partnerMoveHistoryResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get()
  list(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Query(new ZodValidationPipe(moveHistoryQuerySchema)) query: MoveHistoryQuery,
  ): Promise<PartnerMoveHistoryResponse> {
    return this.moves.list(partner, groupId, query);
  }

  @ApiDoc({
    summary: "A short-lived download link for a photo of a move on the partner's job.",
    response: downloadUrlResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get(':moveId/photos/:fileVersionId/url')
  photoUrl(
    @CurrentPartner() partner: PartnerAuth,
    @Param('groupId', idParam) groupId: string,
    @Param('moveId', idParam) moveId: string,
    @Param('fileVersionId', idParam) fileVersionId: string,
  ): Promise<{ url: string; expires_at: string }> {
    return this.moves.photoUrl(partner, groupId, moveId, fileVersionId);
  }
}
