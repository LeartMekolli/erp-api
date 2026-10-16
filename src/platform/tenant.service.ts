import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CreateTenantInput, createTenantSchema } from './tenant-input';

/**
 * Platform-level tenant administration (ADR 0001: tenant creation is a
 * platform-admin action). The tenant table is platform-owned, so this uses the
 * plain client, not inTenant. Plan 2 exposes it as POST /v1/platform/tenants.
 */
@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Throws a ZodError for invalid input and a ConflictException for a taken
   * slug. The unique constraint decides the conflict rather than a prior read,
   * so two concurrent creates cannot both succeed.
   */
  async create(input: CreateTenantInput): Promise<{ id: string; slug: string }> {
    const tenant = createTenantSchema.parse(input);

    try {
      return await this.prisma.tenant.create({
        data: {
          name: tenant.name,
          slug: tenant.slug,
          defaultCurrency: tenant.currency,
          defaultLocale: tenant.locale,
          timezone: tenant.timezone,
        },
        select: { id: true, slug: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Slug ${tenant.slug} is taken`);
      }
      throw error;
    }
  }
}
