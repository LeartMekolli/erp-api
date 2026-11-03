import { ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Shipment } from '../../generated/prisma/client';
import type { Address } from '../orders/order-response';
import { CourierAccountService } from './courier-account.service';
import { COURIER_PROVIDER, CourierError } from './courier-provider';
import type { CourierProvider, Parcel, TrackingStatus } from './courier-provider';

type Tx = Prisma.TransactionClient;

export type ShipmentPurpose = 'order' | 'remake' | 'return';

/** A label bought from the courier service. */
export interface Label {
  shipmentId: string;
  carrier: string;
  service: string;
  tracking: string;
  labelUrl: string;
  cost: Prisma.Decimal;
  currency: string;
}

/** Told once of a shipment the courier delivered, outside any transaction; safe to run twice. */
export type DeliveredHook = (tenantId: string, shipment: Shipment) => Promise<void>;

/** A purchase left `pending` this long belongs to a request that died; it may be tried again. */
const STALE_MS = 5 * 60_000;
const ERROR_MAX_LENGTH = 1000;
const ALREADY = 'A label is already bought, or being bought';

/**
 * Labels (Orders 3 spec, goals 23–25): one per order, claim return and claim remake, bought while staff
 * wait and outside any transaction. A row is reserved `pending` first, so a second purchase is refused;
 * the label is written onto it once bought, so a retry after a timeout uses that label instead of buying
 * another. The caller's own change marks it `bought`.
 */
@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);
  private readonly delivered = new Map<ShipmentPurpose, DeliveredHook>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: CourierAccountService,
    @Inject(COURIER_PROVIDER) private readonly provider: CourierProvider,
  ) {}

  /** Orders (`order`) and Claims (`remake`) are told of deliveries; Couriers depends on neither. */
  onDelivered(purpose: ShipmentPurpose, hook: DeliveredHook): void {
    this.delivered.set(purpose, hook);
  }

  /**
   * Reserves the purchase of a label, in the caller's transaction, under the caller's lock on the order or
   * claim. A label bought and not yet used is answered as it is; a failed try, or one whose request died,
   * is tried again in the same row. A label in use, or being bought now, is a 409.
   */
  async reserve(
    tx: Tx,
    input: { purpose: ShipmentPurpose; orderId?: string; claimId?: string; carrier: string; service: string; parcel: Parcel; userId: string },
  ): Promise<string> {
    const subject = { purpose: input.purpose, orderId: input.orderId ?? null, claimId: input.claimId ?? null };
    const rows = await tx.shipment.findMany({ where: subject, orderBy: { createdAt: 'desc' } });
    const open = rows.find((row) => row.status !== 'failed');
    if (open?.status === 'bought') throw new ConflictException(ALREADY);
    if (open?.tracking) return open.id;
    if (open && Date.now() - open.createdAt.getTime() < STALE_MS) throw new ConflictException(ALREADY);

    // `created_at` is when this try was reserved, so a try in progress is never taken for a dead one.
    const attempt = {
      carrier: input.carrier,
      service: input.service,
      parcel: input.parcel as unknown as Prisma.InputJsonValue,
      createdByUserId: input.userId,
      createdAt: new Date(),
      error: null,
    };
    const again = open ?? rows[0];
    try {
      if (again) {
        // A failed try's shipment at the service holds the address that was refused: ask for a new one.
        // A dead request's may have been bought already: buy that one, never a second.
        await tx.shipment.update({
          where: { id: again.id },
          data: { ...attempt, status: 'pending', ...(again.status === 'failed' ? { providerShipmentId: null } : {}) },
        });
        return again.id;
      }
      return (await tx.shipment.create({ data: { ...subject, ...attempt }, select: { id: true } })).id;
    } catch (error) {
      // shipment_one_open: another purchase for the same order or claim got there first.
      if (isUniqueViolation(error)) throw new ConflictException(ALREADY);
      throw error;
    }
  }

  /**
   * Buys the reserved label, outside any transaction: the service's shipment is created once and its id
   * stored before buying. A refusal marks the try `failed` with the service's reason and is a 503.
   */
  async purchase(tenantId: string, shipmentId: string, from: Address, to: Address): Promise<Label> {
    const row = await this.prisma.inTenant(tenantId, (tx) => tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } }));
    if (row.tracking && row.labelUrl && row.cost && row.currency) return toLabel(row);
    const account = await this.accounts.findFor(tenantId);
    if (!account) {
      await this.fail(tenantId, shipmentId, 'No courier service is set up for this workspace');
      throw new ConflictException('No courier service is set up for this workspace');
    }
    try {
      let providerShipmentId = row.providerShipmentId;
      if (!providerShipmentId) {
        ({ providerShipmentId } = await this.provider.shipment(account.keys, {
          from,
          to,
          parcel: row.parcel as unknown as Parcel,
          isReturn: row.purpose === 'return',
          reference: shipmentId,
        }));
        await this.prisma.inTenant(tenantId, (tx) => tx.shipment.update({ where: { id: shipmentId }, data: { providerShipmentId } }));
      }
      const bought = await this.provider.buy(account.keys, providerShipmentId, row.carrier, row.service);
      const updated = await this.prisma.inTenant(tenantId, (tx) =>
        tx.shipment.update({
          where: { id: shipmentId },
          data: { tracking: bought.tracking, labelUrl: bought.labelUrl, cost: bought.amount.toDecimalPlaces(2), currency: bought.currency },
        }),
      );
      return toLabel(updated);
    } catch (error) {
      if (error instanceof CourierError) {
        await this.fail(tenantId, shipmentId, error.message);
        throw new ServiceUnavailableException(error.message);
      }
      // Anything else leaves nothing bought that staff could see: let them try again at once.
      await this.fail(tenantId, shipmentId, 'The label could not be bought');
      throw error;
    }
  }

  /** In the caller's change: the reserved label is now in use. */
  async markBought(tx: Tx, shipmentId: string): Promise<void> {
    await tx.shipment.updateMany({ where: { id: shipmentId, status: 'pending' }, data: { status: 'bought' } });
  }

  /**
   * A tracking update, outside any transaction: the bought label with that tracking number takes the
   * state, and the first `delivered` sets `delivered_at` and tells the purpose's hook. An unknown tracking
   * number changes nothing. The hook runs again on a retry, so it must be safe to run twice.
   */
  async applyTracking(tenantId: string, tracking: string, status: TrackingStatus): Promise<void> {
    const shipment = await this.prisma.inTenant(tenantId, async (tx) => {
      const found = await tx.shipment.findFirst({ where: { tracking, status: 'bought' } });
      if (!found) return null;
      return tx.shipment.update({
        where: { id: found.id },
        data: { trackingStatus: status, ...(status === 'delivered' && !found.deliveredAt ? { deliveredAt: new Date() } : {}) },
      });
    });
    if (!shipment || status !== 'delivered') return;
    await this.delivered.get(shipment.purpose as ShipmentPurpose)?.(tenantId, shipment);
  }

  private async fail(tenantId: string, shipmentId: string, message: string): Promise<void> {
    try {
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.shipment.updateMany({ where: { id: shipmentId, status: 'pending' }, data: { status: 'failed', error: message.slice(0, ERROR_MAX_LENGTH) } }),
      );
    } catch (error) {
      this.logger.error({ err: error, shipmentId }, 'a failed label purchase could not be recorded');
    }
  }
}

function toLabel(row: Shipment): Label {
  return {
    shipmentId: row.id,
    carrier: row.carrier,
    service: row.service,
    tracking: row.tracking!,
    labelUrl: row.labelUrl!,
    cost: row.cost!,
    currency: row.currency!,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  // A trigger's 23505 reaches Prisma as a raw database error.
  return error instanceof Error && /23505|already bought, or being bought/.test(error.message);
}
