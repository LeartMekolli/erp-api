import { CourierError } from './courier-provider';
import { FakeCourierProvider, signFakeCourierEvent } from './fake-courier-provider';

const keys = { apiKey: 'EZTKtest' };
const from = { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE' };
const to = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const parcel = { weight_g: 1_200, length_cm: 20, width_cm: 15, height_cm: 10 };

describe('the fake courier provider', () => {
  it('prices standard and express by the started kilo, in EUR, or USD to the United States', async () => {
    const fake = new FakeCourierProvider();
    const { rates } = await fake.shipment(keys, { from, to, parcel, isReturn: false, reference: 'r1' });
    expect(rates.map((rate) => [rate.carrier, rate.service, rate.amount.toFixed(2), rate.currency])).toEqual([
      ['FakeCarrier', 'standard', '6.90', 'EUR'],
      ['FakeCarrier', 'express', '13.90', 'EUR'],
    ]);
    const us = await fake.shipment(keys, { from, to: { ...to, country: 'US' }, parcel, isReturn: false, reference: 'r2' });
    expect(us.rates.every((rate) => rate.currency === 'USD')).toBe(true);
  });

  it('buys a label with a tracking number, and refuses an address whose first line is FAIL', async () => {
    const fake = new FakeCourierProvider();
    const { providerShipmentId } = await fake.shipment(keys, { from, to, parcel, isReturn: false, reference: 'r3' });
    const label = await fake.buy(keys, providerShipmentId, 'FakeCarrier', 'standard');
    expect(label.tracking).toMatch(/^FAKE\d{6}$/);
    expect(label.labelUrl).toMatch(/^https:\/\/labels\.example\.test\/.+\.pdf$/);
    expect(fake.bought).toHaveLength(1);

    const refused = await fake.shipment(keys, { from, to: { ...to, line1: 'FAIL' }, parcel, isReturn: false, reference: 'r4' });
    await expect(fake.buy(keys, refused.providerShipmentId, 'FakeCarrier', 'standard')).rejects.toThrow(CourierError);
  });

  it('reads the events it signs', () => {
    const fake = new FakeCourierProvider();
    const raw = Buffer.from(JSON.stringify({ id: 'evt_2', description: 'tracker.updated', result: { tracking_code: 'FAKE000001', status: 'in_transit' } }));
    expect(fake.verifyEvent(raw, signFakeCourierEvent(raw, 'whsec_fake'), 'whsec_fake')).toEqual({ id: 'evt_2', tracking: 'FAKE000001', status: 'in_transit' });
  });
});
