-- CreateTable
CREATE TABLE "credit_campaign" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "name" TEXT NOT NULL,
    "credits_per_customer" INTEGER NOT NULL,
    "credit_days" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "budget" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "budget_used_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_campaign_target" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "campaign_id" UUID NOT NULL,
    "plan_id" UUID,
    "customer_id" UUID,

    CONSTRAINT "credit_campaign_target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_campaign_tenant_id_status_idx" ON "credit_campaign"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_campaign_tenant_id_id_key" ON "credit_campaign"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "credit_campaign_target_tenant_id_campaign_id_idx" ON "credit_campaign_target"("tenant_id", "campaign_id");

-- CreateIndex
CREATE INDEX "credit_campaign_target_tenant_id_plan_id_idx" ON "credit_campaign_target"("tenant_id", "plan_id");

-- CreateIndex
CREATE INDEX "credit_campaign_target_tenant_id_customer_id_idx" ON "credit_campaign_target"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "credit_campaign" ADD CONSTRAINT "credit_campaign_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign" ADD CONSTRAINT "credit_campaign_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign_target" ADD CONSTRAINT "credit_campaign_target_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign_target" ADD CONSTRAINT "credit_campaign_target_tenant_id_campaign_id_fkey" FOREIGN KEY ("tenant_id", "campaign_id") REFERENCES "credit_campaign"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign_target" ADD CONSTRAINT "credit_campaign_target_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "plan"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign_target" ADD CONSTRAINT "credit_campaign_target_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE credit_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_campaign FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_campaign_isolation ON credit_campaign
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE credit_campaign_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_campaign_target FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_campaign_target_isolation ON credit_campaign_target
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Whole credits and days above zero, an end after the start, a budget holding at least one grant,
-- and the states (src/modules/payments/credits/credit-response.ts).
ALTER TABLE credit_campaign ADD CONSTRAINT credit_campaign_values_check
  CHECK (credits_per_customer > 0 AND credit_days > 0 AND budget >= credits_per_customer AND ends_at > starts_at);
ALTER TABLE credit_campaign ADD CONSTRAINT credit_campaign_status_check CHECK (status IN ('draft', 'active', 'paused', 'ended'));
-- A target names one plan or one customer, never both.
ALTER TABLE credit_campaign_target ADD CONSTRAINT credit_campaign_target_one_check
  CHECK ((plan_id IS NULL) <> (customer_id IS NULL));

-- Deleting a workspace cascades into campaigns and the users who created them, in no fixed order.
-- This key is checked at commit, when the whole cascade is done; deleting the user alone, while a
-- campaign points at it, still fails at commit.
ALTER TABLE credit_campaign ALTER CONSTRAINT credit_campaign_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
