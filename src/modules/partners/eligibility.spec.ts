import { Prisma } from '../../generated/prisma/client';
import { eligible, roomFor } from './eligibility';
import type { JobFacts, PartnerFacts } from './eligibility';

const decimal = (value: string) => new Prisma.Decimal(value);

describe('room for a job', () => {
  const capabilities = [
    { stepTypeId: 'casting', capacity: 200 },
    { stepTypeId: 'polishing', capacity: 100 },
  ];
  const steps = new Set(['casting', 'polishing']);

  it('fits a job that fills a step exactly, and reports what is left at each step', () => {
    const room = roomFor(capabilities, new Map([['polishing', 90]]), 10, steps);
    expect(room.ok).toBe(true);
    expect(room.left).toEqual(
      new Map([
        ['casting', 190],
        ['polishing', 0],
      ]),
    );
  });

  it('refuses a job one piece over, at any step', () => {
    const room = roomFor(capabilities, new Map([['polishing', 91]]), 10, steps);
    expect(room.ok).toBe(false);
    expect(room.left.get('polishing')).toBe(-1);
  });

  it('counts only the steps of the job', () => {
    expect(roomFor(capabilities, new Map([['polishing', 500]]), 10, new Set(['casting'])).ok).toBe(true);
  });
});

describe('who may take a job', () => {
  const today = new Date('2026-12-26T09:00:00Z');

  /** Ten cast rings, silver and polished, 15 mm at their largest. */
  const job: JobFacts = {
    quantity: 10,
    partnerStepTypeIds: new Set(['casting', 'polishing', 'final_qc']),
    pricedStepTypeIds: new Set(['casting', 'polishing']),
    optionValueIds: ['silver', 'polished'],
    largestSideMm: decimal('15'),
    names: new Map([
      ['casting', 'casting'],
      ['polishing', 'polishing'],
      ['final_qc', 'final_qc'],
      ['silver', 'silver_925'],
      ['polished', 'polished'],
      ['gold', 'gold_plated'],
    ]),
  };

  const capability = (stepTypeId: string, extra: object = {}) => ({
    stepTypeId,
    minQuantity: 1,
    maxQuantity: null,
    maxSizeMm: null,
    capacity: 200,
    ...extra,
  });

  /** CastCo, able to take the job. */
  const castco: PartnerFacts = {
    status: 'approved',
    capabilities: [capability('casting', { maxSizeMm: decimal('40') }), capability('polishing'), capability('final_qc')],
    offeredValueIds: new Set(['silver', 'polished']),
    closedPeriods: [{ startsOn: '2026-12-31', endsOn: '2027-01-01' }],
    openJobs: 2,
    maxOpenJobs: 3,
    pricedStepTypeIds: new Set(['casting', 'polishing']),
    load: new Map([['casting', 40]]),
  };

  it('takes a partner that can do everything the job needs', () => {
    expect(eligible(job, castco, today)).toEqual({
      ok: true,
      left: new Map([
        ['casting', 150],
        ['polishing', 190],
        ['final_qc', 190],
      ]),
    });
  });

  it('names every reason a partner cannot take the job', () => {
    const unable: PartnerFacts = {
      ...castco,
      status: 'suspended',
      capabilities: [capability('casting', { maxQuantity: 5, maxSizeMm: decimal('12') }), capability('final_qc', { capacity: 5 })],
      offeredValueIds: new Set(['silver']),
      closedPeriods: [{ startsOn: '2026-12-24', endsOn: '2026-12-31' }],
      openJobs: 3,
      pricedStepTypeIds: new Set(['casting']),
    };
    const result = eligible({ ...job, optionValueIds: ['silver', 'polished', 'gold'] }, unable, today);
    expect(result).toEqual({
      ok: false,
      reasons: [
        'The partner is suspended',
        'No capability for polishing',
        'casting takes at most 5 pieces per job; the job has 10',
        'casting takes pieces up to 12 mm; the largest side is 15 mm',
        'Does not offer polished, gold_plated',
        'No room for final_qc: 5 pieces a period, 0 taken, the job needs 10',
        'Closed today (2026-12-24 to 2026-12-31)',
        'Already has 3 open jobs, its limit',
        'No price for polishing',
      ],
    });
  });

  it('refuses fewer pieces than a step takes, and a partner still being set up', () => {
    const result = eligible(
      { ...job, quantity: 1 },
      { ...castco, status: 'setting_up', capabilities: [capability('casting', { minQuantity: 2 }), capability('polishing'), capability('final_qc')] },
      today,
    );
    expect(result).toEqual({
      ok: false,
      reasons: ['The partner is not approved yet', 'casting takes at least 2 pieces per job; the job has 1'],
    });
  });

  it('refuses a job with no partner steps: it is made in-house', () => {
    expect(eligible({ ...job, partnerStepTypeIds: new Set() }, castco, today)).toEqual({
      ok: false,
      reasons: ['The job has no partner steps; make it in-house'],
    });
  });

  it('ignores the size limit when the job has no measured size, and the job limit when there is none', () => {
    expect(eligible({ ...job, largestSideMm: null }, { ...castco, maxOpenJobs: null, openJobs: 50 }, today).ok).toBe(true);
  });
});
