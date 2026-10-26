import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '../../config/config.service';
import type { PrismaService } from '../../database/prisma.service';
import type { Prisma, Quote } from '../../generated/prisma/client';
import type { TenantAuth } from '../identity/auth-context';
import { WorkOrdersService } from './work-orders.service';

describe('starting a quote', () => {
  it('refuses to start a quote with a picked workshop when nothing can hand the job over', async () => {
    const tx = {
      quote: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'quote',
          partnerId: 'partner',
          partnerCost: '120.00',
          quantity: 10,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      },
      workOrderGroup: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const prisma = { inTenant: (_tenantId: string, work: (client: typeof tx) => unknown) => work(tx) } as unknown as PrismaService;
    const service = new WorkOrdersService(prisma, {} as ConfigService);

    await expect(service.startFromQuote({ tenantId: 'tenant', userId: 'user' } as TenantAuth, 'quote')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(tx.workOrderGroup.create).not.toHaveBeenCalled();
  });

  describe('inside a caller’s transaction', () => {
    /** A quote that lapsed an hour ago, for a product with no workflow, so a start stops at the workflow. */
    const lapsed = {
      id: 'quote',
      productId: 'product',
      partnerId: null,
      quantity: 10,
      expiresAt: new Date(Date.now() - 3_600_000),
    } as unknown as Quote;
    const transaction = () => ({
      workOrderGroup: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      product: { findUnique: jest.fn().mockResolvedValue({ workflowId: null, category: { workflowId: null } }) },
    });
    const service = new WorkOrdersService({} as PrismaService, {} as ConfigService);
    const auth = { tenantId: 'tenant', userId: 'user' };

    it('refuses a lapsed quote started on its own', async () => {
      const tx = transaction();
      await expect(
        service.startQuoted(tx as unknown as Prisma.TransactionClient, auth, lapsed, { type: 'quote', id: lapsed.id }),
      ).rejects.toThrow(new ConflictException('The quote has expired; quote again to start production'));
      expect(tx.workOrderGroup.create).not.toHaveBeenCalled();
    });

    it("leaves an order line's quote expiry to the order, which checked it when it was placed", async () => {
      const tx = transaction();
      // Past the expiry check: it stops at the next one, the product's workflow.
      await expect(
        service.startQuoted(tx as unknown as Prisma.TransactionClient, auth, lapsed, { type: 'order_line', id: 'line' }),
      ).rejects.toThrow(new ConflictException('The product has no workflow'));
      // An order line is looked up as the source, never the quote.
      expect(tx.workOrderGroup.findFirst).toHaveBeenCalledWith({ where: { sourceType: 'order_line', sourceId: 'line' } });
    });
  });
});
