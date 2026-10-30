import { DISMISS_DAYS, fingerprint, targetsFit } from './suggestions';

const JOB = '01900000-0000-7000-8000-000000000003';
const PARTNER = '01900000-0000-7000-8000-000000000004';

describe('fingerprint', () => {
  it('is the same for the same kind and targets in any order', () => {
    expect(
      fingerprint('offer_job', [
        { type: 'job', id: JOB },
        { type: 'partner', id: PARTNER },
      ]),
    ).toBe(
      fingerprint('offer_job', [
        { type: 'partner', id: PARTNER },
        { type: 'job', id: JOB },
      ]),
    );
  });

  it('differs for another kind on the same target', () => {
    expect(fingerprint('review_partner', [{ type: 'partner', id: PARTNER }])).not.toBe(
      fingerprint('contact_customer', [{ type: 'customer', id: PARTNER }]),
    );
    expect(fingerprint('review_partner', [{ type: 'partner', id: PARTNER }])).not.toBe(
      fingerprint('review_partner', [{ type: 'partner', id: JOB }]),
    );
  });

  it('keeps a dismissal for 14 days', () => {
    expect(DISMISS_DAYS).toBe(14);
  });
});

describe('targetsFit', () => {
  it("takes exactly one record of each of the kind's types", () => {
    expect(targetsFit('offer_job', [{ type: 'job', id: JOB }, { type: 'partner', id: PARTNER }])).toBe(true);
    expect(targetsFit('offer_job', [{ type: 'job', id: JOB }])).toBe(false);
    expect(targetsFit('offer_job', [{ type: 'job', id: JOB }, { type: 'job', id: PARTNER }])).toBe(false);
    expect(targetsFit('chase_invoice', [{ type: 'order', id: JOB }])).toBe(false);
  });
});
