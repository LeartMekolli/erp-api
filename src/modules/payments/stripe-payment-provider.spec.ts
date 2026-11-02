import Stripe from 'stripe';
import { InvalidSignatureError } from './payment-provider';
import { Prisma } from '../../generated/prisma/client';
import { StripePaymentProvider, stripeCreditNote, stripeCustomerUpdate, toMinorUnits } from './stripe-payment-provider';

/** Offline only: nothing here talks to Stripe. */

describe('stripeCustomerUpdate', () => {
  it('sends the address with its region as the state, and the VAT number as a custom field invoices print', () => {
    const update = stripeCustomerUpdate({
      address: { name: 'Brightline GmbH', line1: 'Ringstraße 4', line2: '3. Stock', city: 'Wien', postal_code: '1010', region: 'Wien', country: 'AT' },
      vatNumber: 'ATU12345678',
    });
    expect(update).toEqual({
      address: { line1: 'Ringstraße 4', line2: '3. Stock', city: 'Wien', postal_code: '1010', state: 'Wien', country: 'AT' },
      invoice_settings: { custom_fields: [{ name: 'VAT', value: 'ATU12345678' }] },
    });
  });

  it('clears what is no longer there', () => {
    expect(stripeCustomerUpdate({ address: null, vatNumber: null })).toEqual({ address: '', invoice_settings: { custom_fields: '' } });
    // Missing parts of an address are sent empty, so an old line2 or state doesn't stay behind.
    expect(
      stripeCustomerUpdate({ address: { name: 'Brightline', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' }, vatNumber: null }).address,
    ).toEqual({ line1: 'Hauptstraße 1', line2: '', city: 'Berlin', postal_code: '10115', state: '', country: 'DE' });
  });
});
describe('stripeCreditNote', () => {
  it('credits the invoice in cents, with the reason as its memo', () => {
    expect(stripeCreditNote({ invoiceId: 'in_123', amount: new Prisma.Decimal('30.5'), currency: 'EUR', reason: 'Claim 3' })).toEqual({
      invoice: 'in_123',
      amount: 3050,
      memo: 'Claim 3',
    });
  });
});

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
