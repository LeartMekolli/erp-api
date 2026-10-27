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

  it('accepts one to five Google client ids, and nothing else', () => {
    expect(parseSetting('auth.google', { clientIds: ['web.apps.example.test'] })).toEqual({
      clientIds: ['web.apps.example.test'],
    });
    for (const clientIds of [[], ['a', 'b', 'c', 'd', 'e', 'f'], [''], 'web.apps.example.test']) {
      expect(() => parseSetting('auth.google', { clientIds })).toThrow(ZodError);
    }
  });
});
