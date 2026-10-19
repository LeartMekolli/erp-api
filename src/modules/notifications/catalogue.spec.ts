import { EVENTS, EventKey, variablesOf } from './catalogue';
import { validateTemplate } from './render';

const events = Object.keys(EVENTS) as EventKey[];

describe('notification catalogue', () => {
  it('declares the five events of the foundation', () => {
    expect(events.sort()).toEqual([
      'auth.password_reset_requested',
      'file.measured',
      'user.invited',
      'user.joined',
      'user.roles_changed',
    ]);
  });

  it.each(events)('%s: the default template validates against its own event', (event) => {
    expect(validateTemplate(event, EVENTS[event].defaults.en)).toEqual([]);
  });

  it.each(events)('%s: events with a secret variable are email-only with a single-target audience', (event) => {
    const definition = EVENTS[event];
    if (!Object.values(variablesOf(event)).some((variable) => variable.secret)) {
      return;
    }
    expect(definition.channels).toEqual(['email']);
    expect(['invitee', 'user']).toContain(definition.audience.kind);
  });

  it.each(events)('%s: every sample is non-empty', (event) => {
    for (const variable of Object.values(variablesOf(event))) {
      expect(variable.sample.length).toBeGreaterThan(0);
    }
  });
});
