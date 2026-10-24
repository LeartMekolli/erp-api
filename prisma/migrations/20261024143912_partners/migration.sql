-- CreateTable
CREATE TABLE "partner" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'setting_up',
    "accepts_direct_orders" BOOLEAN NOT NULL DEFAULT false,
    "agreement_file_version_id" UUID,
    "agreement_signed_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_tenant_id_status_idx" ON "partner"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_tenant_id_id_key" ON "partner"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_tenant_id_agreement_file_version_id_fkey" FOREIGN KEY ("tenant_id", "agreement_file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE partner
  ADD CONSTRAINT partner_status_valid CHECK (status IN ('setting_up', 'approved', 'suspended')),
  ADD CONSTRAINT partner_agreement_complete CHECK ((agreement_file_version_id IS NULL) = (agreement_signed_on IS NULL));

ALTER TABLE partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_isolation ON partner
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Grants the partner permissions to the system roles of existing tenants
-- (SYSTEM_ROLES). Row-level security is forced even for the table owner, so
-- each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'partner.read'
    FROM role r
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('partner.write'), ('partner.assign')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
