import { EVENTS, EventKey, urlVariablesOf, variablesOf } from './catalogue';
import { validateTemplate } from './render';

const events = Object.keys(EVENTS) as EventKey[];

describe('notification catalogue', () => {
  it('declares the events of the foundation, the catalog, customers, partners, orders, payments, the AI and reporting', () => {
    expect(events.sort()).toEqual([
      'ai.limit_nearly_used',
      'ai.limit_used',
      'auth.password_reset_requested',
      'campaign.budget_used',
      'claim.decided',
      'claim.opened',
      'claim.remake_shipped',
      'credits.added',
      'customer.invited',
      'export.scheduled_ready',
      'file.measured',
      'invoice.overdue',
      'invoice.overdue.staff',
      'invoice.sent',
      'material.price.stale',
      'order.cancelled',
      'order.delivered',
      'order.partner_lost',
      'order.placed',
      'order.progress',
      'order.received',
      'order.shipped',
      'order.unpaid_cancelled',
      'partner.invited',
      'partner.job.declined',
      'partner.job.direct',
      'partner.job.expired',
      'partner.job.offered',
      'partner.job.reassigned',
      'partner.job.reworked',
      'partner.submitted',
      'payment.received',
      'payment.requested',
      'payout.failed',
      'payout.paid',
      'payouts.reminder',
      'refund.failed',
      'refund.made',
      'report.export_failed',
      'report.export_ready',
      'subscription.changed',
      'subscription.downgrade_scheduled',
      'subscription.ended',
      'subscription.ended.staff',
      'subscription.payment_failed',
      'subscription.started',
      'subscription.upgrade_failed',
      'user.invited',
      'user.joined',
      'user.roles_changed',
    ]);
  });

  it.each(events)('%s: the default template validates against its own event', (event) => {
    expect(validateTemplate(event, EVENTS[event].defaults.en)).toEqual([]);
  });

  it.each(events)('%s: events with a secret variable are email-only with a single-target audience', (event) => {
    const definition = EVENTS[event];
    if (!Object.values(variablesOf(event)).some((variable) => variable.secret)) {
      return;
    }
    expect(definition.channels).toEqual(['email']);
    expect(['invitee', 'user']).toContain(definition.audience.kind);
  });

  it('tells the customer of its orders, and staff who read orders of each new one', () => {
    for (const event of ['order.placed', 'order.progress', 'order.shipped', 'order.delivered', 'order.cancelled'] as const) {
      expect([event, EVENTS[event].audience, EVENTS[event].subjectType]).toEqual([event, { kind: 'customer' }, 'order']);
    }
    expect(EVENTS['order.received'].audience).toEqual({ kind: 'permission', permission: 'order.read' });
    expect(Object.keys(variablesOf('order.shipped')).sort()).toEqual(['courier', 'number', 'tracking']);
    // Workflow 2: the customer-facing step name only, never defects, photos or comments.
    expect(Object.keys(variablesOf('order.progress')).sort()).toEqual(['number', 'step']);
    expect(EVENTS['order.progress'].channels).toEqual(['email', 'feed']);
  });

  it('tells staff who read orders of each new claim, about its order (Orders 3 spec, goal 7)', () => {
    expect(EVENTS['claim.opened'].audience).toEqual({ kind: 'permission', permission: 'order.read' });
    expect(EVENTS['claim.opened'].subjectType).toBe('order');
    expect(Object.keys(variablesOf('claim.opened')).sort()).toEqual(['customer_name', 'number', 'order_number']);
    // The customer hears of each decision: the outcome and the reason it may see, never the fault or staff's note.
    expect([EVENTS['claim.decided'].audience, EVENTS['claim.decided'].subjectType]).toEqual([{ kind: 'customer' }, 'order']);
    expect(Object.keys(variablesOf('claim.decided')).sort()).toEqual(['number', 'order_number', 'outcome', 'reason']);
    // And when a remake ships, as its own parcel.
    expect([EVENTS['claim.remake_shipped'].audience, EVENTS['claim.remake_shipped'].subjectType]).toEqual([{ kind: 'customer' }, 'order']);
    expect(Object.keys(variablesOf('claim.remake_shipped')).sort()).toEqual(['courier', 'number', 'order_number', 'tracking']);
  });

  it('tells each recipient of a scheduled export, about the recipient, once a schedule is made for the month (Orders 3 spec, goal 10)', () => {
    expect([EVENTS['export.scheduled_ready'].audience, EVENTS['export.scheduled_ready'].subjectType]).toEqual([{ kind: 'user' }, 'user']);
    expect(Object.keys(variablesOf('export.scheduled_ready')).sort()).toEqual(['exports', 'month', 'schedule']);
  });

  it("tells the customer's people when a subscription starts, about the customer itself", () => {
    expect(EVENTS['subscription.started'].audience).toEqual({ kind: 'customer' });
    expect(EVENTS['subscription.started'].subjectType).toBe('customer');
    expect(Object.keys(variablesOf('subscription.started')).sort()).toEqual(['interval', 'plan', 'price']);
  });

  it("tells the customer's people of plan changes and failed payments, and staff of a subscription that ended", () => {
    const customer = {
      'subscription.changed': ['plan'],
      'subscription.downgrade_scheduled': ['on', 'plan'],
      'subscription.upgrade_failed': ['plan', 'portal_url'],
      'subscription.payment_failed': ['plan', 'portal_url'],
      'subscription.ended': ['plan'],
    } as const;
    for (const [event, variables] of Object.entries(customer) as [keyof typeof customer, readonly string[]][]) {
      expect([event, EVENTS[event].audience, EVENTS[event].subjectType]).toEqual([event, { kind: 'customer' }, 'customer']);
      expect([event, Object.keys(variablesOf(event)).sort()]).toEqual([event, [...variables]]);
    }
    expect(urlVariablesOf('subscription.payment_failed')).toEqual(new Set(['portal_url']));

    expect(EVENTS['subscription.ended.staff'].audience).toEqual({ kind: 'permission', permission: 'payment.read' });
    expect(EVENTS['subscription.ended.staff'].subjectType).toBe('customer');
    expect(Object.keys(variablesOf('subscription.ended.staff')).sort()).toEqual(['customer', 'pay_later', 'plan']);
  });

  it("tells the customer's people of credits added to their balance", () => {
    expect(EVENTS['credits.added'].audience).toEqual({ kind: 'customer' });
    expect(EVENTS['credits.added'].subjectType).toBe('customer');
    expect(Object.keys(variablesOf('credits.added')).sort()).toEqual(['credits', 'expires_on', 'source']);
  });

  it('tells staff who manage plans when a campaign has used its budget', () => {
    expect(EVENTS['campaign.budget_used'].audience).toEqual({ kind: 'permission', permission: 'plan.write' });
    expect(EVENTS['campaign.budget_used'].subjectType).toBe('credit_campaign');
    expect(Object.keys(variablesOf('campaign.budget_used')).sort()).toEqual(['budget', 'campaign']);
  });

  it("tells staff who manage settings when the workspace's AI limit is nearly or fully used", () => {
    for (const event of ['ai.limit_nearly_used', 'ai.limit_used'] as const) {
      expect([event, EVENTS[event].audience, EVENTS[event].subjectType]).toEqual([
        event,
        { kind: 'permission', permission: 'settings.write' },
        'tenant',
      ]);
      expect([event, Object.keys(variablesOf(event)).sort()]).toEqual([event, ['limit', 'spent']]);
    }
  });

  it.each(events)('%s: every sample is non-empty', (event) => {
    for (const variable of Object.values(variablesOf(event))) {
      expect(variable.sample.length).toBeGreaterThan(0);
    }
  });
});
