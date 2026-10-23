-- AlterTable
ALTER TABLE "step_type" ALTER COLUMN "summary_group" DROP NOT NULL;

-- CreateTable
CREATE TABLE "defect" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "defect_tenant_id_key_key" ON "defect"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "defect_tenant_id_id_key" ON "defect"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "defect" ADD CONSTRAINT "defect_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE defect ENABLE ROW LEVEL SECURITY;
ALTER TABLE defect FORCE ROW LEVEL SECURITY;
CREATE POLICY defect_isolation ON defect
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Grants the workflow permissions to the system roles of existing tenants
-- (SYSTEM_ROLES). Row-level security is forced even for the table owner, so
-- each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('workflow.read'), ('workflow.move')) AS p(permission)
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'workflow.write'
    FROM role r
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
