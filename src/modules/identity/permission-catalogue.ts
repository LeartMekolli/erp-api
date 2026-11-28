import { z } from 'zod';
import { TENANT_PERMISSIONS } from './permissions';
import type { TenantPermission } from './permissions';

/** The groups the role editor shows, in display order. */
export const PERMISSION_AREAS = [
  { key: 'settings', name: 'Settings' },
  { key: 'people', name: 'People and roles' },
  { key: 'files', name: 'Files and templates' },
  { key: 'catalog', name: 'Catalog' },
  { key: 'pricing', name: 'Pricing' },
  { key: 'customers', name: 'Customers' },
  { key: 'production', name: 'Production' },
  { key: 'partners', name: 'Partners' },
  { key: 'orders', name: 'Orders' },
  { key: 'payments', name: 'Payments' },
  { key: 'reports', name: 'Reports' },
  { key: 'ai', name: 'AI and knowledge' },
] as const;

export type PermissionAreaKey = (typeof PERMISSION_AREAS)[number]['key'];

export interface PermissionInfo {
  area: PermissionAreaKey;
  name: string;
  description: string;
  /** Held on purpose: money, access or bulk data. */
  sensitive: boolean;
  /** Permissions this one is useless without. */
  requires: readonly TenantPermission[];
}

export const PERMISSION_CATALOGUE = {
  'settings.read': {
    area: 'settings',
    name: 'View settings',
    description: "Lets someone see the workspace's settings.",
    sensitive: false,
    requires: [],
  },
  'settings.write': {
    area: 'settings',
    name: 'Change settings',
    description: "Lets someone change the workspace's settings.",
    sensitive: false,
    requires: ['settings.read'],
  },
  'user.read': {
    area: 'people',
    name: 'View people',
    description: 'Lets someone see the staff, their roles and their skills.',
    sensitive: false,
    requires: [],
  },
  'user.invite': {
    area: 'people',
    name: 'Invite people',
    description: 'Lets someone invite new staff to the workspace.',
    sensitive: false,
    // An invitation names a role, and only `GET /roles` lists them.
    requires: ['user.read', 'role.read'],
  },
  'user.deactivate': {
    area: 'people',
    name: 'Deactivate and reactivate people',
    description: "Lets someone remove a person's access to the workspace, and give it back.",
    sensitive: true,
    requires: ['user.read'],
  },
  'role.read': {
    area: 'people',
    name: 'View roles',
    description: 'Lets someone see the roles and what each one allows.',
    sensitive: false,
    requires: [],
  },
  'role.write': {
    area: 'people',
    name: 'Manage roles',
    description: 'Lets someone create, rename, change and delete custom roles.',
    sensitive: true,
    requires: ['role.read'],
  },
  'role.assign': {
    area: 'people',
    name: 'Assign roles',
    description: 'Lets someone change which roles a person holds.',
    sensitive: true,
    requires: ['role.read', 'user.read'],
  },
  'template.read': {
    area: 'files',
    name: 'View templates',
    description: 'Lets someone see the document templates.',
    sensitive: false,
    requires: [],
  },
  'template.write': {
    area: 'files',
    name: 'Edit templates',
    description: 'Lets someone create and change document templates.',
    sensitive: false,
    requires: ['template.read'],
  },
  'file.read': {
    area: 'files',
    name: 'View files',
    description: 'Lets someone see and download uploaded files.',
    sensitive: false,
    requires: [],
  },
  'file.write': {
    area: 'files',
    name: 'Upload files',
    description: 'Lets someone upload and remove files.',
    sensitive: false,
    requires: ['file.read'],
  },
  'catalog.read': {
    area: 'catalog',
    name: 'View the catalog',
    description: 'Lets someone see products, materials and their options.',
    sensitive: false,
    requires: [],
  },
  'catalog.write': {
    area: 'catalog',
    name: 'Edit the catalog',
    description: 'Lets someone create and change products, materials and their options.',
    sensitive: false,
    requires: ['catalog.read'],
  },
  'material.price.override': {
    area: 'catalog',
    name: 'Override material prices',
    description: "Lets someone replace a material's price by hand; every change is audited.",
    sensitive: true,
    requires: ['catalog.read'],
  },
  'pricing.read': {
    area: 'pricing',
    name: 'View pricing',
    description: 'Lets someone see the pricing setup and the staff breakdown of quotes, with internal costs and margins.',
    sensitive: false,
    requires: [],
  },
  'pricing.write': {
    area: 'pricing',
    name: 'Edit pricing',
    description: 'Lets someone change the pricing setup.',
    sensitive: false,
    requires: ['pricing.read'],
  },
  'quote.create': {
    area: 'pricing',
    name: 'Request quotes',
    description: 'Lets someone request a quote and read its customer summary.',
    sensitive: false,
    requires: [],
  },
  'customer.read': {
    area: 'customers',
    name: 'View customers',
    description: 'Lets someone see customer organisations and their people.',
    sensitive: false,
    requires: [],
  },
  'customer.write': {
    area: 'customers',
    name: 'Edit customers',
    description: 'Lets someone create and change customer organisations and their people.',
    sensitive: false,
    requires: ['customer.read'],
  },
  'workflow.read': {
    area: 'production',
    name: 'View production',
    description: 'Lets someone see workflows, defects and the quality control history.',
    sensitive: false,
    requires: [],
  },
  'workflow.write': {
    area: 'production',
    name: 'Edit workflows',
    description: 'Lets someone change workflows and record defects.',
    sensitive: false,
    requires: ['workflow.read'],
  },
  'workflow.move': {
    area: 'production',
    name: 'Move work through production',
    description: 'Lets someone start work orders and move pieces through their steps.',
    sensitive: false,
    requires: ['workflow.read'],
  },
  'partner.read': {
    area: 'partners',
    name: 'View partners',
    description: 'Lets someone see partner workshops and what they can do.',
    sensitive: false,
    requires: [],
  },
  'partner.write': {
    area: 'partners',
    name: 'Manage partners',
    description: 'Lets someone set up and approve partner workshops.',
    sensitive: false,
    requires: ['partner.read'],
  },
  'partner.assign': {
    area: 'partners',
    name: 'Assign jobs to partners',
    description: 'Lets someone offer, withdraw and reassign jobs, and set what a partner is owed.',
    sensitive: false,
    requires: ['partner.read', 'order.read'],
  },
  'order.read': {
    area: 'orders',
    name: 'View orders',
    description: 'Lets someone see orders and their progress.',
    sensitive: false,
    requires: [],
  },
  'order.write': {
    area: 'orders',
    name: 'Place and cancel orders',
    description: 'Lets someone place and cancel orders.',
    sensitive: false,
    requires: ['order.read'],
  },
  'order.ship': {
    area: 'orders',
    name: 'Ship orders',
    description: 'Lets someone mark orders as shipped.',
    sensitive: false,
    requires: ['order.read'],
  },
  'payment.read': {
    area: 'payments',
    name: 'View payments',
    description: 'Lets someone see the ledger and the payment state of orders.',
    sensitive: false,
    requires: [],
  },
  'payment.setup': {
    area: 'payments',
    name: 'Set up payments',
    description: "Lets someone set the workspace's Stripe keys.",
    sensitive: true,
    requires: ['payment.read'],
  },
  'payment.write': {
    area: 'payments',
    name: 'Manage payment terms and manual payments',
    description: 'Lets someone set payment terms, release orders past the credit limit and mark orders paid by hand.',
    sensitive: true,
    requires: ['payment.read'],
  },
  'payment.refund': {
    area: 'payments',
    name: 'Refund payments',
    description: 'Lets someone refund money to a customer.',
    sensitive: true,
    requires: ['payment.read'],
  },
  'payment.payout': {
    area: 'payments',
    name: 'Pay out partners',
    description: 'Lets someone pay partners what they are owed.',
    sensitive: true,
    requires: ['payment.read'],
  },
  'plan.write': {
    area: 'payments',
    name: 'Manage plans and credits',
    description: 'Lets someone change plans, credit packs and campaigns.',
    sensitive: true,
    requires: ['payment.read'],
  },
  'credit.grant': {
    area: 'payments',
    name: 'Grant credits',
    description: 'Lets someone give a customer credits by hand, with a reason; every grant is audited.',
    sensitive: true,
    requires: ['payment.read'],
  },
  'report.read': {
    area: 'reports',
    name: 'View reports',
    description: "Lets someone see the staff dashboard's numbers and attention list.",
    sensitive: false,
    requires: [],
  },
  'report.export': {
    area: 'reports',
    name: 'Export data',
    description: 'Lets someone export data as files; each export also needs the permission of the screen its data comes from.',
    sensitive: true,
    requires: ['report.read'],
  },
  'ai.use': {
    area: 'ai',
    name: 'Use the AI assistant',
    description: 'Lets someone ask the AI and refresh the briefing, paid by the workspace within its monthly limit.',
    sensitive: false,
    requires: [],
  },
  'knowledge.write': {
    area: 'ai',
    name: 'Write knowledge articles',
    description: 'Lets someone write, publish and archive knowledge base articles.',
    sensitive: false,
    requires: [],
  },
} as const satisfies Record<TenantPermission, PermissionInfo>;

export interface PermissionView {
  key: TenantPermission;
  area: { key: PermissionAreaKey; name: string };
  name: string;
  description: string;
  sensitive: boolean;
  requires: TenantPermission[];
}

/** Every tenant permission, by area order, then in `TENANT_PERMISSIONS` order. */
export function permissionList(): PermissionView[] {
  const catalogue: Record<TenantPermission, PermissionInfo> = PERMISSION_CATALOGUE;
  return PERMISSION_AREAS.flatMap((area) =>
    TENANT_PERMISSIONS.filter((key) => catalogue[key].area === area.key).map((key) => {
      const info = catalogue[key];
      return {
        key,
        area: { key: area.key, name: area.name },
        name: info.name,
        description: info.description,
        sensitive: info.sensitive,
        requires: [...info.requires],
      };
    }),
  );
}

export const permissionListResponseSchema = z.strictObject({
  data: z.array(
    z.strictObject({
      key: z.string(),
      area: z.strictObject({ key: z.string(), name: z.string() }),
      name: z.string(),
      description: z.string(),
      sensitive: z.boolean(),
      requires: z.array(z.string()),
    }),
  ),
});
