import { Prisma } from '../../generated/prisma/client';
import { forRangeReader, revenueByGroup, revenueByProduct } from './range-metrics';
import type { RangeMetrics } from './range-metrics';
import { emptyWeek } from './week-metrics';

const d = (value: string) => new Prisma.Decimal(value);
const RING = '01900000-0000-7000-8000-000000000001';
const PENDANT = '01900000-0000-7000-8000-000000000002';
const BAND = '01900000-0000-7000-8000-000000000003';

describe('range metrics', () => {
  it('adds up revenue per customer group in the currency, most first, then by name, with no group last', () => {
    const WHOLESALE = '01900000-0000-7000-8000-000000000011';
    const RETAIL = '01900000-0000-7000-8000-000000000012';
    const ATELIERS = '01900000-0000-7000-8000-000000000013';
    const groups = new Map([
      [WHOLESALE, { key: 'wholesale', name: 'Wholesale' }],
      [RETAIL, { key: 'retail', name: 'Retail' }],
      [ATELIERS, { key: 'ateliers', name: 'Ateliers' }],
    ]);
    const orders = [
      { groupId: WHOLESALE, net: d('40.00'), currency: 'EUR' },
      { groupId: null, net: d('500.00'), currency: 'EUR' },
      { groupId: RETAIL, net: d('90.00'), currency: 'EUR' },
      { groupId: WHOLESALE, net: d('60.00'), currency: 'EUR' },
      // Another currency isn't added to the workspace's, as the dashboard's revenue isn't.
      { groupId: RETAIL, net: d('900.00'), currency: 'USD' },
      { groupId: ATELIERS, net: d('100.00'), currency: 'EUR' },
    ];

    expect(revenueByGroup(orders, groups, 'EUR')).toEqual([
      { customer_group: { id: ATELIERS, key: 'ateliers', name: 'Ateliers' }, revenue: '100.00' },
      { customer_group: { id: WHOLESALE, key: 'wholesale', name: 'Wholesale' }, revenue: '100.00' },
      { customer_group: { id: RETAIL, key: 'retail', name: 'Retail' }, revenue: '90.00' },
      { customer_group: null, revenue: '500.00' },
    ]);
    expect(revenueByGroup([], groups, 'EUR')).toEqual([]);
  });

  it('adds up revenue per product in the currency, most first, then by name', () => {
    const lines = [
      { productId: RING, name: 'Ring', quantity: 2, total: d('40.00'), currency: 'EUR' },
      { productId: PENDANT, name: 'Pendant', quantity: 1, total: d('90.00'), currency: 'EUR' },
      { productId: RING, name: 'Ring', quantity: 3, total: d('60.00'), currency: 'EUR' },
      // Another currency isn't added to the workspace's, as the dashboard's revenue isn't.
      { productId: PENDANT, name: 'Pendant', quantity: 5, total: d('500.00'), currency: 'USD' },
      { productId: BAND, name: 'Band', quantity: 4, total: d('100.00'), currency: 'EUR' },
    ];

    expect(revenueByProduct(lines, 'EUR')).toEqual([
      { product_id: BAND, name: 'Band', quantity: 4, revenue: '100.00' },
      { product_id: RING, name: 'Ring', quantity: 5, revenue: '100.00' },
      { product_id: PENDANT, name: 'Pendant', quantity: 1, revenue: '90.00' },
    ]);
  });

  it('gives nothing for no lines', () => {
    expect(revenueByProduct([], 'EUR')).toEqual([]);
  });

  it('leaves revenue per product and per customer group out without payment.read, as the other money figures', () => {
    const metrics: RangeMetrics = {
      ...emptyWeek('EUR'),
      orders: {
        placed: 1,
        revenue: '90.00',
        average_value: '90.00',
        by_product: [{ product_id: RING, name: 'Ring', quantity: 1, revenue: '90.00' }],
        by_customer_group: [{ customer_group: null, revenue: '90.00' }],
      },
    };

    expect(forRangeReader(metrics, { money: true, partners: true }).orders).toEqual(metrics.orders);
    expect(forRangeReader(metrics, { money: false, partners: false }).orders).toEqual({ placed: 1 });
    expect(forRangeReader(metrics, { money: false, partners: false })).not.toHaveProperty('partners');
  });
});
