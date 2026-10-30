-- CreateTable
CREATE TABLE "report_export" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "permissions" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rows" INTEGER,
    "file_id" UUID,
    "error" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "downloaded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "report_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_export_tenant_id_requested_by_user_id_id_idx" ON "report_export"("tenant_id", "requested_by_user_id", "id");

-- CreateIndex
CREATE INDEX "report_export_tenant_id_status_expires_at_idx" ON "report_export"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_export_tenant_id_id_key" ON "report_export"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "file"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_tenant_id_requested_by_user_id_fkey" FOREIGN KEY ("tenant_id", "requested_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (Reporting 2 plan, Task 1): row-level security, checks, keys checked at commit, and the
-- new permission for every existing workspace's owner role.

ALTER TABLE report_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_export FORCE ROW LEVEL SECURITY;
CREATE POLICY report_export_isolation ON report_export
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- EXPORT_KINDS in src/modules/reporting/exports/export-kinds.ts.
ALTER TABLE report_export ADD CONSTRAINT report_export_kind_check
  CHECK (kind IN ('customers', 'orders', 'partners', 'accounting_invoices', 'accounting_payments', 'accounting_refunds',
                  'accounting_payouts', 'dashboard_pdf'));
ALTER TABLE report_export ADD CONSTRAINT report_export_status_check
  CHECK (status IN ('pending', 'ready', 'failed', 'expired'));
ALTER TABLE report_export ADD CONSTRAINT report_export_permissions_check CHECK (permissions IS NOT NULL);
ALTER TABLE report_export ADD CONSTRAINT report_export_rows_check CHECK (rows IS NULL OR rows >= 0);
-- A ready or expired export has its file, its finish and its expiry; a failed one its message.
ALTER TABLE report_export ADD CONSTRAINT report_export_ready_check
  CHECK (status NOT IN ('ready', 'expired') OR (file_id IS NOT NULL AND finished_at IS NOT NULL AND expires_at IS NOT NULL));
ALTER TABLE report_export ADD CONSTRAINT report_export_failed_check
  CHECK (status <> 'failed' OR (error IS NOT NULL AND finished_at IS NOT NULL));

-- Deleting a workspace cascades into its exports, files and users in no fixed order. These keys are
-- checked at commit, when the whole cascade is done.
ALTER TABLE report_export ALTER CONSTRAINT report_export_tenant_id_file_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_export ALTER CONSTRAINT report_export_tenant_id_requested_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Every existing workspace's owner role gets `report.export`; new workspaces get it from SYSTEM_ROLES.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'report.export'
    FROM role r
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
