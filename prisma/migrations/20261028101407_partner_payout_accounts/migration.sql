-- CreateTable
CREATE TABLE "partner_payout_account" (
    "partner_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "provider_account_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payout_account_pkey" PRIMARY KEY ("partner_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_account_tenant_id_partner_id_key" ON "partner_payout_account"("tenant_id", "partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payout_account_tenant_id_provider_account_id_key" ON "partner_payout_account"("tenant_id", "provider_account_id");

-- AddForeignKey
ALTER TABLE "partner_payout_account" ADD CONSTRAINT "partner_payout_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payout_account" ADD CONSTRAINT "partner_payout_account_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE partner_payout_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_payout_account FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_payout_account_isolation ON partner_payout_account
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- No row is `not_connected`; a row always has an account at the provider.
ALTER TABLE partner_payout_account ADD CONSTRAINT partner_payout_account_state_check
  CHECK (state IN ('onboarding', 'ready', 'restricted'));
