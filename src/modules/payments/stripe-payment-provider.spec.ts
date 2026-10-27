import Stripe from 'stripe';
import { InvalidSignatureError } from './payment-provider';
import { StripePaymentProvider, toMinorUnits } from './stripe-payment-provider';

/** Offline only: nothing here talks to Stripe. */
describe('toMinorUnits', () => {
  it('rounds half up to cents', () => {
    expect(toMinorUnits('12.345', 'EUR')).toBe(1235);
    expect(toMinorUnits('12.344', 'EUR')).toBe(1234);
  });

  it('uses no decimals for a zero-decimal currency', () => {
    expect(toMinorUnits('5', 'JPY')).toBe(5);
  });
});

describe('StripePaymentProvider.verifyEvent', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'checkout.session.completed',
    account: 'acct_1',
    data: { object: { id: 'cs_1' } },
  });
  const header = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret });

  it('accepts a header Stripe would send and reads the event', () => {
    const event = new StripePaymentProvider().verifyEvent(Buffer.from(payload), header, secret);

    expect(event).toEqual({ id: 'evt_1', type: 'checkout.session.completed', objectId: 'cs_1', connectedAccountId: 'acct_1' });
  });

  it('refuses a tampered body and a wrong secret', () => {
    const provider = new StripePaymentProvider();

    expect(() => provider.verifyEvent(Buffer.from(payload.replace('cs_1', 'cs_2')), header, secret)).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(Buffer.from(payload), header, 'whsec_other')).toThrow(InvalidSignatureError);
  });
});
