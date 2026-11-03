import { BadRequestException } from '@nestjs/common';
import { ZodError } from 'zod';
import { isSettingKey, parseSetting } from './setting-keys';

describe('setting keys', () => {
  it('accepts a valid notification sender', () => {
    expect(parseSetting('notification.sender', { name: 'Ops', email: 'ops@example.test' })).toEqual({
      name: 'Ops',
      email: 'ops@example.test',
    });
  });

  it('rejects an invalid value with the field-level validation error', () => {
    expect(() =>
      parseSetting('notification.sender', { name: 'Ops', email: 'not-an-email' }),
    ).toThrow(ZodError);
  });

  it('rejects an unknown key', () => {
    expect(isSettingKey('made.up')).toBe(false);
    expect(() => parseSetting('made.up' as never, {})).toThrow(BadRequestException);
  });

  it('does not treat inherited object properties as keys', () => {
    expect(isSettingKey('toString')).toBe(false);
  });

  it('rejects a business calendar with an out-of-range weekday', () => {
    expect(() =>
      parseSetting('business.calendar', { workingDays: [1, 2, 9], startHour: 9, endHour: 17 }),
    ).toThrow(ZodError);
  });

  it('rejects a business calendar that ends before it starts', () => {
    expect(() =>
      parseSetting('business.calendar', { workingDays: [1, 2, 3], startHour: 17, endHour: 9 }),
    ).toThrow(ZodError);
  });

  it('accepts closed dates on the business calendar, and none', () => {
    const calendar = { workingDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
    expect(parseSetting('business.calendar', { ...calendar, closedDates: ['2026-12-25'] })).toEqual({
      ...calendar,
      closedDates: ['2026-12-25'],
    });
    expect(parseSetting('business.calendar', calendar)).toEqual({ ...calendar, closedDates: [] });
    expect(() => parseSetting('business.calendar', { ...calendar, closedDates: ['25 Dec'] })).toThrow(ZodError);
  });

  it('accepts partner routing with an offer deadline of 1 to 720 hours', () => {
    expect(parseSetting('partners.routing', { offerHours: 24, splitOrderLines: false })).toEqual({
      offerHours: 24,
      splitOrderLines: false,
    });
    for (const offerHours of [0, 721, 1.5]) {
      expect(() => parseSetting('partners.routing', { offerHours, splitOrderLines: true })).toThrow(ZodError);
    }
  });

  it('accepts order scheduling buffers of 0 to 60 working days', () => {
    const scheduling = { bufferDays: 2, assemblyAllowanceDays: 1 };
    expect(parseSetting('orders.scheduling', scheduling)).toEqual(scheduling);
    expect(parseSetting('orders.scheduling', { bufferDays: 0, assemblyAllowanceDays: 60 })).toEqual({ bufferDays: 0, assemblyAllowanceDays: 60 });
    for (const bad of [{ bufferDays: -1 }, { bufferDays: 61 }, { assemblyAllowanceDays: -1 }, { assemblyAllowanceDays: 61 }, { bufferDays: 1.5 }]) {
      expect(() => parseSetting('orders.scheduling', { ...scheduling, ...bad })).toThrow(ZodError);
    }
  });

  it('accepts partner score weights of 0 to 10 each', () => {
    const weights = { quality: 3, scrap: 2, reliability: 2, onTime: 1, rating: 3 };
    expect(parseSetting('partners.scoreWeights', weights)).toEqual(weights);
    expect(() => parseSetting('partners.scoreWeights', { ...weights, rating: 11 })).toThrow(ZodError);
    expect(() => parseSetting('partners.scoreWeights', { ...weights, scrap: -1 })).toThrow(ZodError);
  });

  it('accepts AI tool prices as whole credits from 1 to 1000, one for each tool', () => {
    const prices = { recommendations: 10, marketing: 5, brand_content: 3, image: 5 };
    expect(parseSetting('ai.toolPrices', prices)).toEqual(prices);
    for (const image of [0, 2.5, 1001]) {
      expect(() => parseSetting('ai.toolPrices', { ...prices, image })).toThrow(ZodError);
    }
    expect(() => parseSetting('ai.toolPrices', { recommendations: 10, marketing: 5, brand_content: 3 })).toThrow(ZodError);
  });

  it('accepts one to five Google client ids, and nothing else', () => {
    expect(parseSetting('auth.google', { clientIds: ['web.apps.example.test'] })).toEqual({
      clientIds: ['web.apps.example.test'],
    });
    for (const clientIds of [[], ['a', 'b', 'c', 'd', 'e', 'f'], [''], 'web.apps.example.test']) {
      expect(() => parseSetting('auth.google', { clientIds })).toThrow(ZodError);
    }
  });

  it('accepts priority bands with unique keys and starts, none named like the default band', () => {
    const gold = { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true };
    const priority = {
      weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
      defaultBand: { key: 'standard', name: 'Standard' },
      bands: [gold, { key: 'silver', name: 'Silver', from: 50, firstInLine: false, mayPickPartner: false }],
    };
    expect(parseSetting('customers.priority', priority)).toEqual(priority);
    for (const bands of [[gold, { ...gold, from: 60 }], [gold, { ...gold, key: 'platinum' }], [{ ...gold, key: 'standard' }], [{ ...gold, from: 0 }]]) {
      expect(() => parseSetting('customers.priority', { ...priority, bands })).toThrow(ZodError);
    }
    expect(() => parseSetting('customers.priority', { ...priority, weights: { ...priority.weights, payment: 11 } })).toThrow(ZodError);
  });

  it('accepts the two monthly schedules, each on or off with up to 20 recipients', () => {
    const recipient = '01900000-0000-7000-8000-000000000001';
    const schedules = { accounting: { enabled: true, recipientUserIds: [recipient] }, top_customers: { enabled: false, recipientUserIds: [] } };
    expect(parseSetting('reports.schedules', schedules)).toEqual(schedules);
    const many = Array.from({ length: 21 }, (_, index) => `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`);
    for (const accounting of [{ enabled: true, recipientUserIds: many }, { enabled: true, recipientUserIds: ['not-a-user'] }, { enabled: 'yes', recipientUserIds: [] }]) {
      expect(() => parseSetting('reports.schedules', { ...schedules, accounting })).toThrow(ZodError);
    }
    expect(() => parseSetting('reports.schedules', { accounting: schedules.accounting })).toThrow(ZodError);
  });

  it('accepts a claim window of 1 to 365 days and up to 20 reasons with unique keys', () => {
    const reasons = [
      { key: 'defect', name: 'Defect' },
      { key: 'wrong_size', name: 'Wrong size' },
      { key: 'damaged_in_transit', name: 'Damaged in transit' },
      { key: 'other', name: 'Other' },
    ];
    expect(parseSetting('orders.claims', { windowDays: 30, reasons })).toEqual({ windowDays: 30, reasons });
    for (const windowDays of [0, 366, 1.5]) {
      expect(() => parseSetting('orders.claims', { windowDays, reasons })).toThrow(ZodError);
    }
    const tooMany = Array.from({ length: 21 }, (_, index) => ({ key: `reason_${index}`, name: `Reason ${index}` }));
    for (const bad of [[], tooMany, [...reasons, { key: 'defect', name: 'Another defect' }], [{ key: 'Not A Key', name: 'Bad' }]]) {
      expect(() => parseSetting('orders.claims', { windowDays: 30, reasons: bad })).toThrow(ZodError);
    }
  });

  it('accepts the job summary switched off, and instructions of at most 2 000 characters', () => {
    expect(parseSetting('ai.jobSummary', { enabled: false })).toEqual({ enabled: false });
    expect(parseSetting('ai.jobSummary', { enabled: true, instructions: 'Mention the alloy.' })).toEqual({ enabled: true, instructions: 'Mention the alloy.' });
    expect(() => parseSetting('ai.jobSummary', { enabled: true, instructions: 'x'.repeat(2_001) })).toThrow(ZodError);
    expect(() => parseSetting('ai.jobSummary', {})).toThrow(ZodError);
  });
});
