import type { TenantPermission } from '../identity/permissions';

/** Who a notification reaches, resolved server-side (D71, plan N4). */
export type Audience =
  | { kind: 'invitee' }
  | { kind: 'user' }
  | { kind: 'permission'; permission: TenantPermission }
  /** The user who uploaded the file version the notification is about. */
  | { kind: 'uploader' };

export interface VariableSpec {
  /** Shown by the template preview. */
  sample: string;
  /** Sealed at rest and never shown in the feed (plan N2). */
  secret?: true;
  /** Rendered as a link in HTML email, when it is http(s). */
  url?: true;
  /** A template override must use it. */
  required?: true;
}

export interface EventDefinition {
  audience: Audience;
  channels: readonly ('email' | 'feed')[];
  subjectType: 'invitation' | 'user' | 'file_version';
  variables: Record<string, VariableSpec>;
  defaults: { en: { subject: string; body: string } };
}

/**
 * Every notification the system can raise (D71): who it reaches, where, which
 * variables its templates may use, and the repo's default wording. Tenants
 * override the wording (D69); nothing else here is configurable.
 */
export const EVENTS = {
  'user.invited': {
    audience: { kind: 'invitee' },
    channels: ['email'],
    subjectType: 'invitation',
    variables: {
      tenant_name: { sample: 'Acme Print' },
      link: { sample: 'https://acme.example/accept-invitation#token=sample', secret: true, url: true, required: true },
    },
    defaults: {
      en: {
        subject: 'You are invited to {{ tenant_name }}',
        body:
          'Hello,\n\nYou have been invited to join {{ tenant_name }}. Choose a password to accept:\n\n{{ link }}\n\n' +
          'The link works once and expires in 7 days. If you did not expect this invitation, you can ignore this email.',
      },
    },
  },
  'auth.password_reset_requested': {
    audience: { kind: 'user' },
    channels: ['email'],
    subjectType: 'user',
    variables: {
      tenant_name: { sample: 'Acme Print' },
      user_name: { sample: 'Ada Lovelace' },
      link: { sample: 'https://acme.example/reset-password#token=sample', secret: true, url: true, required: true },
    },
    defaults: {
      en: {
        subject: 'Reset your {{ tenant_name }} password',
        body:
          'Hello {{ user_name }},\n\nSomeone asked to reset your password for {{ tenant_name }}. Choose a new one here:\n\n' +
          '{{ link }}\n\nThe link works once and expires in 1 hour. If you did not ask for this, ignore this email; ' +
          'your password stays the same.',
      },
    },
  },
  'user.joined': {
    audience: { kind: 'permission', permission: 'user.invite' },
    channels: ['email', 'feed'],
    subjectType: 'user',
    variables: {
      user_name: { sample: 'Ada Lovelace' },
      user_email: { sample: 'ada@acme.example' },
    },
    defaults: {
      en: {
        subject: '{{ user_name }} joined your workspace',
        body: '{{ user_name }} ({{ user_email }}) accepted their invitation and can now sign in.',
      },
    },
  },
  'user.roles_changed': {
    audience: { kind: 'user' },
    channels: ['email', 'feed'],
    subjectType: 'user',
    variables: {
      user_name: { sample: 'Ada Lovelace' },
      roles: { sample: 'owner, member' },
    },
    defaults: {
      en: {
        subject: 'Your roles have changed',
        body:
          'Hello {{ user_name }},\n\nYour roles are now: {{ roles }}.\n\n' +
          'If you did not expect this change, contact your workspace owner.',
      },
    },
  },
  // Raised by the measurement job once a version is checksummed and measured (plan S10).
  'file.measured': {
    audience: { kind: 'uploader' },
    channels: ['email', 'feed'],
    subjectType: 'file_version',
    variables: {
      file_name: { sample: 'poster-a2.pdf' },
      measures: { sample: 'page_count: 3 count' },
    },
    defaults: {
      en: {
        subject: '{{ file_name }} is ready',
        body: 'Your file {{ file_name }} has been checked and measured.\n\nMeasures: {{ measures }}',
      },
    },
  },
} as const satisfies Record<string, EventDefinition>;

export type EventKey = keyof typeof EVENTS;

export type EventVariables<E extends EventKey> = Record<keyof (typeof EVENTS)[E]['variables'], string>;

export function isEventKey(value: string): value is EventKey {
  return Object.prototype.hasOwnProperty.call(EVENTS, value);
}

/** The variables of an event, without the literal types of the catalogue. */
export function variablesOf(event: EventKey): Record<string, VariableSpec> {
  return EVENTS[event].variables;
}

/** Variables rendered as links in HTML email. */
export function urlVariablesOf(event: EventKey): ReadonlySet<string> {
  return new Set(
    Object.entries(variablesOf(event))
      .filter(([, spec]) => spec.url)
      .map(([name]) => name),
  );
}

/** Each variable's sample value, for the template preview. */
export function samplesOf(event: EventKey): Record<string, string> {
  return Object.fromEntries(Object.entries(variablesOf(event)).map(([name, spec]) => [name, spec.sample]));
}
