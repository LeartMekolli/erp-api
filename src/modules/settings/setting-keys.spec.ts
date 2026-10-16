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
});
