import { Prisma } from '../../generated/prisma/client';
import { FakePaymentProvider } from './fake-payment-provider';
import { InvalidSignatureError, ProviderRefusedError } from './payment-provider';
import type { ProviderKeys } from './payment-provider';

const keys: ProviderKeys = { secretKey: 'sk_test_fake' };
const checkoutInput = (idempotencyKey: string) => ({
  amount: new Prisma.Decimal('100.00'),
  currency: 'EUR',
  description: 'Order 1',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  successUrl: 'https://shop.test/ok',
  cancelUrl: 'https://shop.test/no',
  metadata: { order_id: 'o1' },
  idempotencyKey,
});

describe('FakePaymentProvider', () => {
  it('gives the same checkout for the same idempotency key', async () => {
    const provider = new FakePaymentProvider();

    const first = await provider.createCheckout(keys, checkoutInput('k1'));
    const again = await provider.createCheckout(keys, checkoutInput('k1'));
    const other = await provider.createCheckout(keys, checkoutInput('k2'));

    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
    expect(first.id).toMatch(/^fake_checkout_\d+$/);
  });

  it('reports a completed checkout as paid, with a fee of 2.9% + 0.30', async () => {
    const provider = new FakePaymentProvider();
    // Every instance shares one store, so each test uses keys of its own.
    const { id } = await provider.createCheckout(keys, checkoutInput('k3'));

    expect(await provider.getCheckout(keys, id)).toMatchObject({ status: 'open', paid: false });

    provider.completeCheckout(id);
    const done = await provider.getCheckout(keys, id);

    expect(done.status).toBe('complete');
    expect(done.paid).toBe(true);
    expect(done.amount.toFixed(2)).toBe('100.00');
    expect(done.fee.toFixed(2)).toBe('3.20');
    expect(done.paymentId).not.toBeNull();
  });

  it('expires a checkout, and expiring a finished one is not an error', async () => {
    const provider = new FakePaymentProvider();
    const { id } = await provider.createCheckout(keys, checkoutInput('k4'));

    await provider.expireCheckout(keys, id);
    await provider.expireCheckout(keys, id);

    expect((await provider.getCheckout(keys, id)).status).toBe('expired');
  });

  it('verifies what sign produced, as Stripe formats it', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

    const event = provider.verifyEvent(Buffer.from(body), provider.sign(body, 'whsec_a'), 'whsec_a');

    expect(event).toEqual({ id: 'evt_1', type: 'checkout.session.completed', objectId: 'cs_1', connectedAccountId: null });
  });

  it('reads the connected account of an event', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_2', type: 'account.updated', account: 'acct_9', data: { object: { id: 'acct_9' } } });

    const event = provider.verifyEvent(Buffer.from(body), provider.sign(body, 'whsec_a'), 'whsec_a');

    expect(event.connectedAccountId).toBe('acct_9');
  });

  it('refuses a changed body, a wrong secret and a malformed header', () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ id: 'evt_1', type: 't', data: { object: { id: 'x' } } });
    const header = provider.sign(body, 'whsec_a');

    expect(() => provider.verifyEvent(Buffer.from(body + ' '), header, 'whsec_a')).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(Buffer.from(body), header, 'whsec_b')).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(Buffer.from(body), 'nonsense', 'whsec_a')).toThrow(InvalidSignatureError);
  });

  it('refuses one transfer after failNextTransfer, then works again', async () => {
    const provider = new FakePaymentProvider();
    const input = (idempotencyKey: string) => ({
      destination: 'acct_1',
      amount: new Prisma.Decimal('30.00'),
      currency: 'EUR',
      description: 'Payout',
      idempotencyKey,
    });

    provider.failNextTransfer('balance_insufficient');

    await expect(provider.transfer(keys, input('t1'))).rejects.toThrow(ProviderRefusedError);
    await expect(provider.transfer(keys, input('t1'))).resolves.toMatchObject({ id: expect.stringMatching(/^fake_transfer_/) });
  });
});
