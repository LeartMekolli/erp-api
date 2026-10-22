-- CreateTable
CREATE TABLE "unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "factor" DECIMAL(18,9) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_tenant_id_key_key" ON "unit"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "unit" ADD CONSTRAINT "unit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).
ALTER TABLE unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit FORCE ROW LEVEL SECURITY;

CREATE POLICY unit_isolation ON unit
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE unit
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- Grants the catalog permissions to the system roles of existing tenants
-- (SYSTEM_ROLES). Row-level security is forced even for the table owner, so
-- each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'catalog.read'
    FROM role r
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('catalog.write'), ('material.price.override')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
