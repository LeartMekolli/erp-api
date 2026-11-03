import type { PrismaService } from '../database/prisma.service';
import type { CourierAccountService } from '../modules/couriers/courier-account.service';
import { SettingsService } from '../modules/settings/settings.service';

// The demo's couriers, planning and job summaries (Orders 3 spec, goals 12–25), on top of its workflows
// and ordering setup (`seed-workflows.ts`, `seed-orders.ts`): a courier account for the fake courier
// service, a live-rate shipping method priced by it, daily capacities for final QC and finishing, and the
// partner job summary switched on.

// The fake courier service takes any key; an EZTK key reads as test mode, as EasyPost's do.
const ACCOUNT = {
  api_key: 'EZTKdemo_fake_courier_key',
  webhook_secret: 'whsec_demo_courier',
  from_address: { name: 'Demo workshop', line1: 'Werkstraße 5', city: 'Berlin', postal_code: '10115', country: 'DE' },
};
const LIVE_METHOD = {
  key: 'courier_live',
  name: 'Tracked courier',
  liveCarrier: 'FakeCarrier',
  liveService: 'standard',
  defaultParcel: { weight_g: 1_000, length_cm: 20, width_cm: 15, height_cm: 10 },
};
/** Pieces a day, by step type key: final QC and the demo's two finishing steps. */
const CAPACITIES: Record<string, number> = { final_qc: 40, polishing: 25, finish: 25 };

export interface ProductionSeedCounts {
  /** 1 when the courier account was set, 0 when the workspace had one. */
  account: number;
  /** 1 when the live-rate method was created, 0 when its key existed. */
  liveMethods: number;
  capacities: number;
  /** 1 when `ai.jobSummary` was set, 0 when the workspace had it. */
  jobSummary: number;
}

/**
 * Seeds the demo's couriers, capacities and job summaries into one workspace. Idempotent: the account
 * is found by workspace, the method by key, a capacity by step type and the setting by key; anything
 * found is left as it is. A step type the workspace lacks gets no capacity. The account is sealed and
 * audited through `CourierAccountService`, as the system.
 */
export async function seedProduction(
  deps: { prisma: PrismaService; accounts: CourierAccountService },
  tenantId: string,
): Promise<ProductionSeedCounts> {
  const created: ProductionSeedCounts = { account: 0, liveMethods: 0, capacities: 0, jobSummary: 0 };

  await deps.prisma.inTenant(tenantId, async (tx) => {
    if (!(await tx.courierAccount.findFirst({ select: { tenantId: true } }))) {
      await deps.accounts.set(tx, tenantId, { type: 'system' }, ACCOUNT);
      created.account++;
    }

    if (!(await tx.shippingMethod.findFirst({ where: { key: LIVE_METHOD.key } }))) {
      await tx.shippingMethod.create({ data: { ...LIVE_METHOD, price: null } });
      created.liveMethods++;
    }

    const types = await tx.stepType.findMany({ where: { key: { in: Object.keys(CAPACITIES) } }, include: { capacity: true } });
    for (const type of types) {
      if (type.capacity) continue;
      await tx.stepCapacity.create({ data: { stepTypeId: type.id, dailyPieces: CAPACITIES[type.key] } });
      created.capacities++;
    }

    if (!(await tx.tenantSetting.findFirst({ where: { key: 'ai.jobSummary' } }))) {
      await new SettingsService().set(tx, 'ai.jobSummary', { enabled: true });
      created.jobSummary++;
    }
  });

  return created;
}
