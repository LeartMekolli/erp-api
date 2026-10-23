-- CreateTable
CREATE TABLE "external_identity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_identity_tenant_id_user_id_idx" ON "external_identity"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identity_tenant_id_provider_subject_key" ON "external_identity"("tenant_id", "provider", "subject");

-- AddForeignKey
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE external_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identity FORCE ROW LEVEL SECURITY;

CREATE POLICY external_identity_isolation ON external_identity
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
