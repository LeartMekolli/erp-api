-- CreateTable
CREATE TABLE "file" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "declared_unit" TEXT,
    "owner_type" TEXT,
    "owner_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "file_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" CHAR(64),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMP(3),
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "file_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measure" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "file_version_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(18,6) NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "measure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_tenant_id_owner_type_owner_id_idx" ON "file"("tenant_id", "owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_tenant_id_id_key" ON "file"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "file_version_storage_key_key" ON "file_version"("storage_key");

-- CreateIndex
CREATE INDEX "file_version_tenant_id_status_created_at_idx" ON "file_version"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "file_version_file_id_number_key" ON "file_version"("file_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "file_version_tenant_id_id_key" ON "file_version"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "measure_tenant_id_idx" ON "measure"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "measure_file_version_id_type_key" ON "measure"("file_version_id", "type");

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "file"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_tenant_id_uploaded_by_user_id_fkey" FOREIGN KEY ("tenant_id", "uploaded_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "measure" ADD CONSTRAINT "measure_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The two user keys above are checked at commit (added by hand: Prisma cannot
-- express it and ignores it). Deleting a tenant removes its users at once but
-- reaches file_version only through file; checked immediately, the uploader key
-- would fail before the versions are gone.

-- Row-level security (src/database/rls.sql.md).
ALTER TABLE file ENABLE ROW LEVEL SECURITY;
ALTER TABLE file FORCE ROW LEVEL SECURITY;

CREATE POLICY file_isolation ON file
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE file
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE file_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_version FORCE ROW LEVEL SECURITY;

CREATE POLICY file_version_isolation ON file_version
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE file_version
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE measure FORCE ROW LEVEL SECURITY;

CREATE POLICY measure_isolation ON measure
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE measure
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- Grants the file permissions to the system roles of existing tenants (plan S9).
-- Row-level security is forced even for the table owner, so each tenant is
-- set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'file.read'
    FROM role r
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;

    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'file.write'
    FROM role r
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
