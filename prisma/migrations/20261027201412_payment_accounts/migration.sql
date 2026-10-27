-- CreateTable
CREATE TABLE "payment_account" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "secret_key" BYTEA NOT NULL,
    "webhook_secret" BYTEA NOT NULL,
    "connect_webhook_secret" BYTEA NOT NULL,
    "publishable_key" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_account_pkey" PRIMARY KEY ("tenant_id")
);

-- AddForeignKey
ALTER TABLE "payment_account" ADD CONSTRAINT "payment_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE payment_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_account FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_account_isolation ON payment_account
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Grants the payment permissions to the system roles of existing tenants (SYSTEM_ROLES): the owner
-- gets all five, the member payment.read. Row-level security is forced even for the table owner,
-- so each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('payment.read'), ('payment.setup'), ('payment.write'), ('payment.refund'), ('payment.payout')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'payment.read'
    FROM role r
    WHERE r.is_system AND r.name = 'member'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
