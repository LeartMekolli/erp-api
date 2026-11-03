import { createHmac } from 'node:crypto';
import { InvalidSignatureError } from '../payments/payment-provider';
import { EasyPostCourierProvider, easyPostShipmentBody } from './easypost-courier-provider';

const address = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const workshop = { name: 'Sol Studio', line1: 'Main street 2', city: 'Munich', postal_code: '80331', country: 'DE', phone: '+49 89 1234' };

describe('the EasyPost courier provider', () => {
  it('sends the parcel in ounces and inches, with the reference and whether it is a return', () => {
    const body = easyPostShipmentBody({
      from: workshop,
      to: address,
      parcel: { weight_g: 500, length_cm: 20, width_cm: 15, height_cm: 10 },
      isReturn: true,
      reference: 'shipment-1',
    });
    expect(body.shipment.parcel).toEqual({ weight: 17.6, length: 7.9, width: 5.9, height: 3.9 });
    expect(body.shipment).toMatchObject({ is_return: true, reference: 'shipment-1' });
    expect(body.shipment.to_address).toMatchObject({ name: 'Luna Jewels', street1: 'Hauptstraße 1', city: 'Berlin', zip: '10115', country: 'DE' });
    expect(body.shipment.from_address).toMatchObject({ phone: '+49 89 1234' });
  });

  it("reads a tracker event signed with the workspace's secret, and refuses any other", () => {
    const provider = new EasyPostCourierProvider();
    const raw = Buffer.from(JSON.stringify({ id: 'evt_1', description: 'tracker.updated', result: { tracking_code: 'EZ100', status: 'delivered' } }));
    const signature = `hmac-sha256-hex=${createHmac('sha256', 'whsec_test').update(raw).digest('hex')}`;
    expect(provider.verifyEvent(raw, signature, 'whsec_test')).toEqual({ id: 'evt_1', tracking: 'EZ100', status: 'delivered' });
    expect(() => provider.verifyEvent(raw, signature, 'another_secret')).toThrow(InvalidSignatureError);
    expect(() => provider.verifyEvent(raw, undefined, 'whsec_test')).toThrow(InvalidSignatureError);
  });
});
