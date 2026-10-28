-- AlterTable
ALTER TABLE "customer_subscription" ADD COLUMN     "pending_plan_price_id" UUID;

-- CreateTable
CREATE TABLE "subscription_notice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_invoice_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscription_notice_tenant_id_customer_id_idx" ON "subscription_notice"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_notice_tenant_id_provider_invoice_id_key" ON "subscription_notice"("tenant_id", "provider_invoice_id");

-- AddForeignKey
ALTER TABLE "customer_subscription" ADD CONSTRAINT "customer_subscription_tenant_id_pending_plan_price_id_fkey" FOREIGN KEY ("tenant_id", "pending_plan_price_id") REFERENCES "plan_price"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_notice" ADD CONSTRAINT "subscription_notice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_notice" ADD CONSTRAINT "subscription_notice_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE subscription_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_notice_isolation ON subscription_notice
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE subscription_notice ADD CONSTRAINT subscription_notice_kind_check
  CHECK (kind IN ('payment_failed', 'upgrade_failed'));

-- Checked at commit, like the subscription's other keys to plan_price (migration `subscriptions`).
ALTER TABLE customer_subscription ALTER CONSTRAINT customer_subscription_tenant_id_pending_plan_price_id_fkey DEFERRABLE INITIALLY DEFERRED;
