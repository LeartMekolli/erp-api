-- Row-level security is the single tenancy layer (ADR 0001). Every tenant-owned
-- table follows this pattern; src/database/rls.sql.md is the template.
--
-- FORCE applies the policy to the table owner as well, so only a superuser or
-- a BYPASSRLS role gets past it. A data migration running as erp_owner must
-- therefore set app.current_tenant_id itself. Foreign-key cascades are
-- unaffected: referential actions always bypass row security.
--
-- The policy: current_setting(..., true) is NULL on a connection that never
-- set the variable, and '' on one that set it in an earlier transaction. NULLIF
-- folds both into NULL, and `tenant_id = NULL` is never true — so outside a
-- tenant scope no rows are visible or writable, whichever connection the pool
-- hands out.
--
-- The default fills tenant_id from the transaction's tenant, so application
-- code never passes it. It deliberately has no NULLIF or missing_ok: an insert
-- outside a tenant scope raises instead of guessing.

ALTER TABLE tenant_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_setting FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_setting_isolation ON tenant_setting
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tenant_setting
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;
