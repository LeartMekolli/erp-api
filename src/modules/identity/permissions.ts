/**
 * Permissions are code; roles are data (F4, D57). Each domain module adds its
 * own keys here: read, write, and named sensitive actions.
 */
export const TENANT_PERMISSIONS = [
  'settings.read',
  'settings.write',
  'user.read',
  'user.invite',
  'user.deactivate',
  'role.read',
  'role.write',
  'role.assign',
  'template.read',
  'template.write',
  'file.read',
  'file.write',
  'catalog.read',
  'catalog.write',
  // Sensitive (F4): replaces a material's price by hand, audited.
  'material.price.override',
  // Pricing configuration and the staff breakdown of quotes (internal costs and margins).
  'pricing.read',
  'pricing.write',
  // Requesting quotes and reading their customer summary.
  'quote.create',
  // Customer organisations and their people.
  'customer.read',
  'customer.write',
  // Workflows, defects, and the QC history (Workflow/QC spec).
  'workflow.read',
  'workflow.write',
  // Starting work orders and moving pieces through their steps.
  'workflow.move',
  // Partner workshops, their setup and approval (Partners spec).
  'partner.read',
  'partner.write',
  // Offering, withdrawing and reassigning jobs, and setting what a partner is owed.
  'partner.assign',
  // Orders (Orders spec): reading them, placing and cancelling them, and shipping them.
  'order.read',
  'order.write',
  'order.ship',
  // Payments (Payments spec): reading the ledger and payment state, then the sensitive actions.
  'payment.read',
  // Sets the workspace's Stripe keys.
  'payment.setup',
  // Payment terms, release past the credit limit, paid by hand.
  'payment.write',
  'payment.refund',
  // Pays partners what they are owed.
  'payment.payout',
  // Plans and credits (Payments 2 spec): plans, credit packs and campaigns.
  'plan.write',
  // Sensitive: gives a customer credits by hand, with a reason, audited.
  'credit.grant',
  // The staff dashboard's numbers and attention list (AI 1 spec).
  'report.read',
  // Asking the AI and refreshing the briefing, paid by the workspace within its monthly limit.
  'ai.use',
  // Writing, publishing and archiving knowledge base articles.
  'knowledge.write',
] as const;

/** Held only by platform admins, through platform-scoped tokens (ADR 0001). */
export const PLATFORM_PERMISSIONS = [
  'platform.tenant.read',
  'platform.tenant.create',
  'platform.tenant.suspend',
  'platform.jobs.read',
  'platform.jobs.retry',
  'platform.diagnostics',
  // Sets a workspace's monthly AI limit (AI 1 spec).
  'platform.tenant.ai',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type Permission = TenantPermission | PlatformPermission;

/**
 * Created with every tenant and never editable (plan 2, P7). Everything else
 * is a custom role the tenant defines.
 */
export const SYSTEM_ROLES = {
  owner: TENANT_PERMISSIONS,
  member: [
    'settings.read',
    'user.read',
    'role.read',
    'template.read',
    'file.read',
    'catalog.read',
    'quote.create',
    'customer.read',
    'workflow.read',
    'workflow.move',
    'partner.read',
    'order.read',
    'order.write',
    'payment.read',
  ],
} as const satisfies Record<string, readonly TenantPermission[]>;

export type SystemRoleName = keyof typeof SYSTEM_ROLES;

const tenantPermissions: ReadonlySet<string> = new Set(TENANT_PERMISSIONS);

export function isTenantPermission(value: string): value is TenantPermission {
  return tenantPermissions.has(value);
}
