import { Injectable } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import type { NotificationTemplate, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { EVENTS, EventKey, samplesOf, urlVariablesOf, variablesOf } from './catalogue';
import { renderTemplate, Template } from './render';
import { resolveTemplate } from './resolve-template';

export interface TemplateOverrideResponse {
  event_key: string;
  locale: string;
  subject: string;
  body: string;
  enabled: boolean;
  updated_at: Date;
}

export interface TemplateEntry {
  event_key: EventKey;
  variables: { name: string; required: boolean }[];
  defaults: { locale: string; subject: string; body: string }[];
  overrides: Omit<TemplateOverrideResponse, 'event_key'>[];
}

function toResponse(row: NotificationTemplate): TemplateOverrideResponse {
  return {
    event_key: row.eventKey,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    enabled: row.enabled,
    updated_at: row.updatedAt,
  };
}

/** What the audit trail keeps of an override. */
function summary(row: NotificationTemplate): Prisma.InputJsonValue {
  return { locale: row.locale, subject: row.subject, body: row.body, enabled: row.enabled };
}

/**
 * Tenant overrides of the repo templates (D69). Every method takes the
 * caller's `inTenant` transaction; validation happens before a call reaches
 * here, in the controller's schemas.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly audit: AuditService) {}

  /** Every event with its variables, repo defaults and this tenant's overrides. Secrets appear by name only. */
  async list(tx: Prisma.TransactionClient): Promise<TemplateEntry[]> {
    const rows = await tx.notificationTemplate.findMany({ orderBy: [{ eventKey: 'asc' }, { locale: 'asc' }] });

    return (Object.keys(EVENTS) as EventKey[]).map((event) => {
      const defaults: Record<string, Template> = EVENTS[event].defaults;
      return {
        event_key: event,
        variables: Object.entries(variablesOf(event)).map(([name, spec]) => ({ name, required: spec.required === true })),
        defaults: Object.entries(defaults).map(([locale, template]) => ({ locale, ...template })),
        overrides: rows
          .filter((row) => row.eventKey === event)
          .map((row) => ({
            locale: row.locale,
            subject: row.subject,
            body: row.body,
            enabled: row.enabled,
            updated_at: row.updatedAt,
          })),
      };
    });
  }

  /**
   * Creates or replaces the override for one event and locale, auditing the
   * change with before and after in the same transaction (F8).
   */
  async save(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    event: EventKey,
    locale: string,
    input: Template & { enabled: boolean },
  ): Promise<TemplateOverrideResponse> {
    const before = await tx.notificationTemplate.findFirst({ where: { eventKey: event, locale } });

    // One atomic upsert on (tenant_id, event_key, locale); the tenant comes
    // from the column default, as in SettingsService.set.
    await tx.$executeRaw`
      INSERT INTO notification_template (id, event_key, locale, subject, body, enabled, updated_by_user_id, updated_at)
      VALUES (${newId()}::uuid, ${event}, ${locale}, ${input.subject}, ${input.body}, ${input.enabled},
              ${auth.userId}::uuid, now())
      ON CONFLICT (tenant_id, event_key, locale)
      DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, enabled = EXCLUDED.enabled,
                    updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = EXCLUDED.updated_at`;

    const after = await tx.notificationTemplate.findFirstOrThrow({ where: { eventKey: event, locale } });

    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'template.override_changed',
      subject: { type: 'notification_template', id: after.id },
      before: before ? summary(before) : undefined,
      after: summary(after),
    });

    return toResponse(after);
  }

  /** The template one recipient gets, in their locale order (plan N5). Used by dispatch. */
  async forRecipient(tx: Prisma.TransactionClient, event: EventKey, locales: string[]): Promise<Template> {
    const overrides = await tx.notificationTemplate.findMany({
      where: { eventKey: event, locale: { in: [...locales, 'en'] } },
    });
    return resolveTemplate(event, locales, overrides);
  }

  /** Renders a template with the event's sample values. */
  preview(event: EventKey, template: Template): { subject: string; text: string; html: string } {
    return renderTemplate(template, samplesOf(event), urlVariablesOf(event));
  }
}
