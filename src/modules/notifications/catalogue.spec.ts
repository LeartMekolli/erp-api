import { EVENTS, EventKey, urlVariablesOf, variablesOf } from './catalogue';
import { validateTemplate } from './render';

const events = Object.keys(EVENTS) as EventKey[];

describe('notification catalogue', () => {
  it('declares the events of the foundation, the catalog, customers, partners, orders and payments', () => {
    expect(events.sort()).toEqual([
      'auth.password_reset_requested',
      'customer.invited',
      'file.measured',
      'invoice.overdue',
      'invoice.overdue.staff',
      'invoice.sent',
      'material.price.stale',
      'order.cancelled',
      'order.delivered',
      'order.partner_lost',
      'order.placed',
      'order.received',
      'order.shipped',
      'order.unpaid_cancelled',
      'partner.invited',
      'partner.job.declined',
      'partner.job.direct',
      'partner.job.expired',
      'partner.job.offered',
      'partner.job.reassigned',
      'partner.submitted',
      'payment.received',
      'payment.requested',
      'payout.failed',
      'payout.paid',
      'payouts.reminder',
      'refund.failed',
      'refund.made',
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
    for (const event of ['order.placed', 'order.shipped', 'order.delivered', 'order.cancelled'] as const) {
      expect([event, EVENTS[event].audience, EVENTS[event].subjectType]).toEqual([event, { kind: 'customer' }, 'order']);
    }
    expect(EVENTS['order.received'].audience).toEqual({ kind: 'permission', permission: 'order.read' });
    expect(Object.keys(variablesOf('order.shipped')).sort()).toEqual(['courier', 'number', 'tracking']);
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

  it.each(events)('%s: every sample is non-empty', (event) => {
    for (const variable of Object.values(variablesOf(event))) {
      expect(variable.sample.length).toBeGreaterThan(0);
    }
  });
});
