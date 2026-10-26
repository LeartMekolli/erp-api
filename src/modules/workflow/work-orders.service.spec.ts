import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '../../config/config.service';
import type { PrismaService } from '../../database/prisma.service';
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
});
