import { EVENTS } from './catalogue';
import { resolveTemplate } from './resolve-template';

const event = 'user.roles_changed';
const override = (locale: string, subject: string, enabled = true) => ({
  locale,
  subject,
  body: `${subject} body`,
  enabled,
});

describe('resolveTemplate', () => {
  it('recipient locale override wins', () => {
    const resolved = resolveTemplate(event, ['de', 'fr'], [override('fr', 'FR'), override('de', 'DE')]);
    expect(resolved).toEqual({ subject: 'DE', body: 'DE body' });
  });

  it('a disabled override falls through to the default', () => {
    expect(resolveTemplate(event, ['de'], [override('de', 'DE', false)])).toEqual(EVENTS[event].defaults.en);
  });

  it('tenant locale is tried before en', () => {
    const resolved = resolveTemplate(event, ['de', 'fr'], [override('en', 'EN'), override('fr', 'FR')]);
    expect(resolved.subject).toBe('FR');
  });

  it('an en override beats the en default', () => {
    expect(resolveTemplate(event, ['en'], [override('en', 'EN')]).subject).toBe('EN');
  });

  it('no override anywhere gives the en default', () => {
    expect(resolveTemplate(event, ['de', 'fr'], [])).toEqual(EVENTS[event].defaults.en);
  });
});
