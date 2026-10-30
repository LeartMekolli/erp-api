import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { AiBrandProfile, Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lockCustomer } from '../../customers/customers.service';
import type { CustomerAuth } from '../../identity/auth-context';
import type { BrandProfileBody, BrandProfileResponse } from './brand-profile-response';

function toResponse(row: AiBrandProfile): BrandProfileResponse {
  return { name: row.name, sells: row.sells, audience: row.audience, tone: row.tone, notes: row.notes, updated_at: row.updatedAt.toISOString() };
}

/** The profile as the model reads it, inside `<brand_profile>`. */
export function describeProfile(row: AiBrandProfile): string {
  return [
    `Brand name: ${row.name}`,
    `Sells: ${row.sells}`,
    `Sells to: ${row.audience}`,
    `Tone of voice: ${row.tone}`,
    ...(row.notes ? [`Notes: ${row.notes}`] : []),
  ].join('\n');
}

/** What the audit keeps of a profile. */
function audited(row: AiBrandProfile): BrandProfileBody {
  return { name: row.name, sells: row.sells, audience: row.audience, tone: row.tone, notes: row.notes };
}

/** A customer's brand profile (AI 2 spec, goals 8–9): one per customer, a form, free to read and save. */
@Injectable()
export class BrandProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The customer's profile, or null without one. */
  of(tx: Prisma.TransactionClient, customerId: string): Promise<AiBrandProfile | null> {
    return tx.aiBrandProfile.findFirst({ where: { customerId } });
  }

  async get(customer: CustomerAuth): Promise<BrandProfileResponse> {
    const row = await this.prisma.inTenant(customer.tenantId, (tx) => this.of(tx, customer.customerId));
    if (!row) throw new NotFoundException('No brand profile yet');
    return toResponse(row);
  }

  /** Writes the whole profile under the customer's lock, audited with what it was before. */
  async save(customer: CustomerAuth, body: BrandProfileBody): Promise<BrandProfileResponse> {
    return this.prisma.inTenant(customer.tenantId, async (tx) => {
      await lockCustomer(tx, customer.customerId);
      const before = await this.of(tx, customer.customerId);
      const data = { ...body, updatedByUserId: customer.userId };
      const after = before
        ? await tx.aiBrandProfile.update({ where: { id: before.id }, data })
        : await tx.aiBrandProfile.create({ data: { ...data, customerId: customer.customerId } });
      await this.audit.record(tx, {
        actor: { type: 'user', id: customer.userId },
        action: 'brand_profile.changed',
        subject: { type: 'customer', id: customer.customerId },
        before: before ? audited(before) : undefined,
        after: audited(after),
      });
      return toResponse(after);
    });
  }
}
