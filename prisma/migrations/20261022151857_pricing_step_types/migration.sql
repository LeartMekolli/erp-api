-- CreateTable
CREATE TABLE "step_type" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "summary_group" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "margin_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "overhead_per_piece" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "quote_valid_days" INTEGER NOT NULL DEFAULT 7,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "step_type_tenant_id_key_key" ON "step_type"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "step_type_tenant_id_id_key" ON "step_type"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_profile_tenant_id_key" ON "pricing_profile"("tenant_id");

-- AddForeignKey
ALTER TABLE "step_type" ADD CONSTRAINT "step_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_profile" ADD CONSTRAINT "pricing_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE step_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_type FORCE ROW LEVEL SECURITY;

CREATE POLICY step_type_isolation ON step_type
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE step_type
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE pricing_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_profile FORCE ROW LEVEL SECURITY;

CREATE POLICY pricing_profile_isolation ON pricing_profile
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE pricing_profile
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- Grants the pricing permissions to the system roles of existing tenants
-- (SYSTEM_ROLES). Row-level security is forced even for the table owner, so
-- each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'quote.create'
    FROM role r
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('pricing.read'), ('pricing.write')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
