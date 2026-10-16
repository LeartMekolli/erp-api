# Making a table tenant-owned

Row-level security is the only tenancy layer (ADR 0001). A tenant-owned table that misses any step below is either readable by every tenant or unusable, so follow all four. `test/tenancy-coverage.e2e-spec.ts` fails if a table with a `tenant_id` column lacks RLS, `FORCE`, a policy or the default.

Replace `<table>` with the SQL table name and `<Model>` with the Prisma model.

## 1. Prisma schema

```prisma
model <Model> {
  id       String @id @default(uuid(7)) @db.Uuid
  tenantId String @default(dbgenerated("(current_setting('app.current_tenant_id'::text))::uuid")) @map("tenant_id") @db.Uuid
  // ...

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // Natural keys are unique per tenant, never globally.
  @@unique([tenantId, <naturalKey>])
  @@index([tenantId])            // only if no unique/index already starts with tenantId
  @@map("<table>")
}
```

The `dbgenerated` string must match the migration's default exactly, character for character, or `prisma migrate dev` will report drift.

## 2. Migration

Generate the table with `prisma migrate dev --create-only`, then append to the generated `migration.sql`:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;

CREATE POLICY <table>_isolation ON <table>
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE <table>
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;
```

Prisma already emits the column default from the schema; the `ALTER COLUMN` line is harmless if it repeats it, and keeps this block self-contained.

No `GRANT` is needed: default privileges from the grants migration give `erp_app` access to every table `erp_owner` creates.

## 3. Access from code

Only inside `inTenant`. Never pass `tenantId` on create; the default fills it.

```ts
await prisma.inTenant(tenantId, (tx) => tx.<model>.create({ data: { ... } }));
await prisma.inTenant(tenantId, (tx) => tx.<model>.update({ where: { id }, data: { ... } }));
```

Keep network calls and slow work outside the block: it holds a pooled connection until it ends.

## 4. Tests

The coverage test picks up the new table on its own. Add an isolation case to the module's e2e tests: a row created under tenant A is invisible to tenant B and cannot be updated or deleted by B by id.

## Why each piece

| Piece | Without it |
|---|---|
| `ENABLE ROW LEVEL SECURITY` | Every tenant sees every row. |
| `FORCE ROW LEVEL SECURITY` | The table owner (migrations, seeds) bypasses the policy. |
| `NULLIF(..., '')` | A pooled connection that ran an earlier tenant transaction holds `''`; the `uuid` cast raises instead of returning no rows. |
| `USING` and `WITH CHECK` | `USING` hides other tenants' rows; `WITH CHECK` refuses inserts and updates that would write into another tenant. |
| `tenant_id` default | Every create must pass `tenantId`, and Prisma's types require it. |
| Default without `NULLIF` | Intentional: an insert outside a tenant scope fails loudly. |
