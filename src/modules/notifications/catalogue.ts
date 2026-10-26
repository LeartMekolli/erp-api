import type { TenantPermission } from '../identity/permissions';

/** Who a notification reaches, resolved server-side (D71, plan N4). */
export type Audience =
  | { kind: 'invitee' }
  | { kind: 'user' }
  | { kind: 'permission'; permission: TenantPermission }
  /** The user who uploaded the file version the notification is about. */
  | { kind: 'uploader' }
  /** The people of the partner the job assignment is for. */
  | { kind: 'partner' };

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
  subjectType:
    | 'invitation'
    | 'customer_invitation'
    | 'partner_invitation'
    | 'partner'
    | 'job_assignment'
    | 'user'
    | 'file_version'
    | 'material';
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
  'customer.invited': {
    audience: { kind: 'invitee' },
    channels: ['email'],
    subjectType: 'customer_invitation',
    variables: {
      tenant_name: { sample: 'Acme Print' },
      customer_name: { sample: 'Luna Jewels' },
      link: { sample: 'https://shop.acme.example/accept-invitation#token=sample', secret: true, url: true, required: true },
    },
    defaults: {
      en: {
        subject: 'You are invited to order for {{ customer_name }} from {{ tenant_name }}',
        body:
          'Hello,\n\nYou have been invited to order for {{ customer_name }} from {{ tenant_name }}. Accept here:\n\n{{ link }}\n\n' +
          'The link works once and expires in 7 days. If you did not expect this invitation, you can ignore this email.',
      },
    },
  },
  'partner.invited': {
    audience: { kind: 'invitee' },
    channels: ['email'],
    subjectType: 'partner_invitation',
    variables: {
      tenant_name: { sample: 'Acme Print' },
      partner_name: { sample: 'CastCo' },
      link: { sample: 'https://acme.example/accept-invitation#token=sample', secret: true, url: true, required: true },
    },
    defaults: {
      en: {
        subject: 'You are invited to work for {{ tenant_name }} as {{ partner_name }}',
        body:
          'Hello,\n\nYou have been invited to take on production jobs from {{ tenant_name }} for {{ partner_name }}. Accept here:\n\n{{ link }}\n\n' +
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
  // Raised once, when a partner's owner says its setup is done (Partners spec, goal 17).
  'partner.submitted': {
    audience: { kind: 'permission', permission: 'partner.write' },
    channels: ['email', 'feed'],
    subjectType: 'partner',
    variables: {
      partner_name: { sample: 'CastCo' },
    },
    defaults: {
      en: {
        subject: '{{ partner_name }} is ready for approval',
        body:
          '{{ partner_name }} has finished setting up what it can do, how much it can take and which options it offers.\n\n' +
          'Check its setup and signed agreement, then approve it so it can be offered jobs.',
      },
    },
  },
  // A job offered to a partner, to accept or decline before the deadline (Partners spec, goal 10).
  // Never names the customer.
  'partner.job.offered': {
    audience: { kind: 'partner' },
    channels: ['email', 'feed'],
    subjectType: 'job_assignment',
    variables: {
      product_name: { sample: 'Custom cast part' },
      quantity: { sample: '10' },
      expires_at: { sample: '2026-10-25T18:00:00.000Z' },
    },
    defaults: {
      en: {
        subject: 'New job offer: {{ quantity }} × {{ product_name }}',
        body: 'You have been offered a job of {{ quantity }} × {{ product_name }}.\n\nAccept or decline it before {{ expires_at }}; after that the offer lapses.',
      },
    },
  },
  // A job a customer sent the partner directly: it is the partner's at once (goal 11).
  'partner.job.direct': {
    audience: { kind: 'partner' },
    channels: ['email', 'feed'],
    subjectType: 'job_assignment',
    variables: {
      product_name: { sample: 'Custom cast part' },
      quantity: { sample: '10' },
    },
    defaults: {
      en: {
        subject: 'New job: {{ quantity }} × {{ product_name }}',
        body: 'A customer picked you for a job of {{ quantity }} × {{ product_name }}. It is yours: you will find it under your jobs.',
      },
    },
  },
  // A job staff moved to the partner mid-way: it is the partner's at once (P16).
  'partner.job.reassigned': {
    audience: { kind: 'partner' },
    channels: ['email', 'feed'],
    subjectType: 'job_assignment',
    variables: {
      product_name: { sample: 'Custom cast part' },
      quantity: { sample: '10' },
    },
    defaults: {
      en: {
        subject: 'Job moved to you: {{ quantity }} × {{ product_name }}',
        body: 'A job of {{ quantity }} × {{ product_name }} was moved to you. It is yours: you will find it under your jobs.',
      },
    },
  },
  'partner.job.declined': {
    audience: { kind: 'permission', permission: 'partner.assign' },
    channels: ['email', 'feed'],
    subjectType: 'job_assignment',
    variables: {
      partner_name: { sample: 'CastCo' },
      product_name: { sample: 'Custom cast part' },
      quantity: { sample: '10' },
    },
    defaults: {
      en: {
        subject: '{{ partner_name }} declined {{ quantity }} × {{ product_name }}',
        body: '{{ partner_name }} declined the job of {{ quantity }} × {{ product_name }}. It needs a partner again.',
      },
    },
  },
  'partner.job.expired': {
    audience: { kind: 'permission', permission: 'partner.assign' },
    channels: ['email', 'feed'],
    subjectType: 'job_assignment',
    variables: {
      partner_name: { sample: 'CastCo' },
      product_name: { sample: 'Custom cast part' },
      quantity: { sample: '10' },
    },
    defaults: {
      en: {
        subject: 'The offer to {{ partner_name }} for {{ quantity }} × {{ product_name }} lapsed',
        body: '{{ partner_name }} did not answer the offer of {{ quantity }} × {{ product_name }} in time. It needs a partner again.',
      },
    },
  },
  // Raised once a day by the price feed job for a feed material with no fresh price (Catalog spec B5, B6).
  'material.price.stale': {
    audience: { kind: 'permission', permission: 'catalog.write' },
    channels: ['email', 'feed'],
    subjectType: 'material',
    variables: {
      material_name: { sample: 'Silver 925' },
      reason: { sample: 'The last feed price is from 2026-10-20T05:00:00.000Z, older than 48 hours.' },
    },
    defaults: {
      en: {
        subject: '{{ material_name }} has no fresh price',
        body:
          '{{ reason }}\n\nUntil a fresh feed price arrives, {{ material_name }} uses its last feed price or its ' +
          'fallback price. Check the fallback, or override the price by hand.',
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
