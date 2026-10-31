import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';
import type { TenantPermission } from '../../identity/permissions';
import type { RangeMetrics } from '../range-metrics';

// The dashboard as a PDF (Reporting 2 spec, goals 14–16): A4, a header, then one heading and its tables
// per section; tables only. Drawn with Noto Sans, which covers Latin, Greek and Cyrillic names (the PDF
// standard fonts garble anything past Western European letters; Reporting 2 review).

const NONE = 'None in this period';
const DASH = '–';

/** Noto Sans (SIL Open Font License, `fonts/OFL.txt`), copied into the build by `nest-cli.json`. */
const FONT_FILES = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf'];

// pdfmake takes fonts by name. Our code reads the files into pdfmake's in-memory file store under those
// names, so pdfmake itself may open nothing from disk or the network. (Its typings omit `virtualfs`.)
const store = (pdfmake as unknown as { virtualfs: { writeFileSync(name: string, content: Buffer): void } }).virtualfs;
for (const file of FONT_FILES) store.writeFileSync(file, readFileSync(join(__dirname, 'fonts', file)));
pdfmake.setFonts({
  NotoSans: { normal: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf', italics: 'NotoSans-Italic.ttf', bolditalics: 'NotoSans-Bold.ttf' },
});
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);

export interface DashboardInput {
  workspace: string;
  from: string;
  to: string;
  /** When it was made, as ISO 8601 in the workspace's time zone. */
  madeAt: string;
  metrics: RangeMetrics;
  may: ReadonlySet<TenantPermission>;
}

const percent = (rate: number | null) => (rate === null ? DASH : `${(rate * 100).toFixed(1)} %`);

/** A heading and its table, or "None in this period" when it has no rows. */
function table(title: string | null, header: string[], rows: TableCell[][]): Content[] {
  const caption: Content[] = title ? [{ text: title, style: 'subheading' }] : [];
  if (rows.length === 0) return [...caption, { text: NONE, style: 'empty' }];
  return [
    ...caption,
    {
      table: { headerRows: 1, widths: header.map((_, index) => (index === 0 ? '*' : 'auto')), body: [header.map((text) => ({ text, bold: true })), ...rows] },
      layout: 'lightHorizontalLines',
      margin: [0, 2, 0, 8],
    },
  ];
}

/** Two columns of figures: a label and its value. */
function figures(rows: [string, string][]): Content {
  return { table: { widths: ['*', 'auto'], body: rows }, layout: 'noBorders', margin: [0, 2, 0, 8] };
}

/**
 * The document of the dashboard's numbers for a range. Money (revenue, revenue per product, the top
 * customers' revenue, slow payers) only with `payment.read`; the partner section only with `partner.read`.
 */
export function dashboardDocument(input: DashboardInput): TDocumentDefinitions {
  const { metrics, may } = input;
  const money = may.has('payment.read');
  const amount = (value: string | null) => (value === null ? DASH : `${value} ${metrics.currency}`);
  const section = (text: string): Content => ({ text, style: 'section' });

  const orders: [string, string][] = [['Orders placed', String(metrics.orders.placed)]];
  if (money) orders.push(['Revenue (net)', amount(metrics.orders.revenue)], ['Average order', amount(metrics.orders.average_value)]);

  const content: Content[] = [
    { text: input.workspace, style: 'title' },
    { text: `${input.from} – ${input.to}`, style: 'subtitle' },
    { text: `Made ${input.madeAt}`, style: 'made' },
    section('Orders'),
    figures(orders),
  ];
  if (money) {
    content.push(
      section('Revenue per product'),
      ...table(
        null,
        ['Product', 'Pieces', 'Revenue'],
        metrics.orders.by_product.map((row) => [row.name, String(row.quantity), amount(row.revenue)]),
      ),
    );
  }
  content.push(
    section('Production'),
    figures([
      ['On time', percent(metrics.production.on_time_rate)],
      ['Defect rate', percent(metrics.production.defect_rate)],
    ]),
    ...table(
      'Hours per step (median)',
      ['Step', 'Hours'],
      metrics.production.step_hours.map((row) => [row.name, row.median_hours.toFixed(1)]),
    ),
    section('Customers'),
    figures([['New customers', String(metrics.customers.new)]]),
    ...table(
      'Top customers',
      money ? ['Customer', 'Revenue'] : ['Customer'],
      metrics.customers.top.map((row) => (money ? [row.name, amount(row.revenue)] : [row.name])),
    ),
    ...table(
      'Ordering less than usual',
      ['Customer', 'Last order'],
      metrics.customers.ordering_less.map((row) => [row.name, row.last_order_on]),
    ),
  );
  if (money) {
    content.push(
      ...table(
        'Slow payers',
        ['Customer', 'Overdue'],
        metrics.customers.slow_payers.map((row) => [row.name, amount(row.overdue)]),
      ),
    );
  }
  if (may.has('partner.read')) {
    content.push(
      section('Partners'),
      ...table('Load', ['Partner', 'Fullest step'], metrics.partners.load.map((row) => [row.name, `${row.percent} %`])),
      ...table('On time', ['Partner', 'On time'], metrics.partners.on_time.map((row) => [row.name, percent(row.rate)])),
    );
  }

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    info: { title: `${input.workspace}: ${input.from} – ${input.to}` },
    content,
    defaultStyle: { font: 'NotoSans', fontSize: 10 },
    styles: {
      title: { fontSize: 18, bold: true },
      subtitle: { fontSize: 12, margin: [0, 2, 0, 0] },
      made: { fontSize: 8, color: '#666666', margin: [0, 2, 0, 12] },
      section: { fontSize: 14, bold: true, margin: [0, 12, 0, 4] },
      subheading: { fontSize: 11, bold: true, margin: [0, 4, 0, 2] },
      empty: { italics: true, color: '#666666', margin: [0, 2, 0, 8] },
    },
  };
}

/** The document drawn as PDF bytes. */
export function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  return pdfmake.createPdf(doc).getBuffer();
}
