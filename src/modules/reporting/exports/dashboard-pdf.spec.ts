import type { TenantPermission } from '../../identity/permissions';
import type { RangeMetrics } from '../range-metrics';
import { dashboardDocument, renderPdf } from './dashboard-pdf';

const LUNA = '01900000-0000-7000-8000-000000000001';
const RING = '01900000-0000-7000-8000-000000000002';
const CASTCO = '01900000-0000-7000-8000-000000000003';
const STEP = '01900000-0000-7000-8000-000000000004';

const metrics: RangeMetrics = {
  currency: 'EUR',
  orders: { placed: 3, revenue: '450.00', average_value: '150.00', by_product: [{ product_id: RING, name: 'Signet ring', quantity: 12, revenue: '400.00' }] },
  production: { on_time_rate: 0.875, step_hours: [{ step_type_id: STEP, name: 'Casting', median_hours: 6.5 }], defect_rate: 0.1 },
  customers: {
    new: 1,
    top: [{ id: LUNA, name: 'Luna Jewels', revenue: '300.00' }],
    ordering_less: [],
    slow_payers: [{ id: LUNA, name: 'Luna Jewels', overdue: '100.00' }],
  },
  partners: { load: [{ id: CASTCO, name: 'CastCo', percent: 40 }], on_time: [{ id: CASTCO, name: 'CastCo', rate: 0.5 }] },
};

const ALL: TenantPermission[] = ['report.read', 'payment.read', 'partner.read'];
const input = (may: TenantPermission[]) => ({
  workspace: 'Northcast Studio',
  from: '2026-07-01',
  to: '2026-09-30',
  madeAt: '2026-10-31T09:00:00+00:00',
  metrics,
  may: new Set(may),
});

/** Every string in a document definition, in order, wherever it sits. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts);
  return [];
}

/** The section headings, in order. */
function headings(doc: ReturnType<typeof dashboardDocument>): string[] {
  return (doc.content as { text?: string; style?: string }[]).filter((node) => node.style === 'section').map((node) => node.text!);
}

describe('dashboard pdf', () => {
  it('lays the sections out in order, under a header with the workspace and the dates', () => {
    const doc = dashboardDocument(input(ALL));

    expect(doc.pageSize).toBe('A4');
    expect(headings(doc)).toEqual(['Orders', 'Revenue per product', 'Production', 'Customers', 'Partners']);
    const all = texts(doc.content);
    expect(all).toEqual(expect.arrayContaining(['Northcast Studio', '2026-07-01 – 2026-09-30', 'Made 2026-10-31T09:00:00+00:00']));
    expect(all).toEqual(expect.arrayContaining(['450.00 EUR', 'Signet ring', '400.00 EUR', '87.5 %', '10.0 %', 'Casting', '6.5', '100.00 EUR', 'CastCo', '40 %', '50.0 %']));
  });

  it('leaves money out without payment.read, and the partners without partner.read', () => {
    const doc = dashboardDocument(input(['report.read']));

    expect(headings(doc)).toEqual(['Orders', 'Production', 'Customers']);
    const all = texts(doc.content);
    for (const money of ['450.00 EUR', '150.00 EUR', '400.00 EUR', '300.00 EUR', '100.00 EUR']) expect(all).not.toContain(money);
    expect(all).not.toContain('Slow payers');
    expect(all).not.toContain('CastCo');
    // What needs no permission stays: orders placed, and the top customers without their revenue.
    expect(all).toEqual(expect.arrayContaining(['3', 'Luna Jewels']));
  });

  it('says so where a table has nothing in the period', () => {
    const empty: RangeMetrics = {
      ...metrics,
      orders: { placed: 0, revenue: '0.00', average_value: null, by_product: [] },
      production: { on_time_rate: null, step_hours: [], defect_rate: null },
      customers: { new: 0, top: [], ordering_less: [], slow_payers: [] },
      partners: { load: [], on_time: [] },
    };

    const all = texts(dashboardDocument({ ...input(ALL), metrics: empty }).content);

    expect(all.filter((text) => text === 'None in this period').length).toBeGreaterThanOrEqual(7);
    expect(all).toContain('–');
  });

  it('draws Polish, Czech, Greek and Cyrillic names as they are (review fix)', async () => {
    const names: RangeMetrics = {
      ...metrics,
      orders: { ...metrics.orders, by_product: [{ ...metrics.orders.by_product[0], name: 'Δαχτυλίδι' }] },
      customers: { ...metrics.customers, top: [{ id: LUNA, name: 'Мастерская Dvořák', revenue: '300.00' }] },
    };

    const bytes = await renderPdf(dashboardDocument({ ...input(ALL), workspace: 'Pracownia Łódź', metrics: names }));

    const { extractText } = await import('unpdf');
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
    for (const name of ['Pracownia Łódź', 'Δαχτυλίδι', 'Мастерская Dvořák', '2026-07-01 – 2026-09-30']) expect(text).toContain(name);
  });
});
