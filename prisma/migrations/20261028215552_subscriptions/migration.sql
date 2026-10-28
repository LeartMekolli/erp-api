-- CreateTable
CREATE TABLE "customer_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "provider_subscription_id" TEXT NOT NULL,
    "plan_price_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_plan_price_id" UUID,
    "allowance_anchor" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_subscription_tenant_id_plan_price_id_idx" ON "customer_subscription"("tenant_id", "plan_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_subscription_tenant_id_customer_id_key" ON "customer_subscription"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_subscription_tenant_id_provider_subscription_id_key" ON "customer_subscription"("tenant_id", "provider_subscription_id");

-- AddForeignKey
ALTER TABLE "customer_subscription" ADD CONSTRAINT "customer_subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_subscription" ADD CONSTRAINT "customer_subscription_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_subscription" ADD CONSTRAINT "customer_subscription_tenant_id_plan_price_id_fkey" FOREIGN KEY ("tenant_id", "plan_price_id") REFERENCES "plan_price"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_subscription" ADD CONSTRAINT "customer_subscription_tenant_id_scheduled_plan_price_id_fkey" FOREIGN KEY ("tenant_id", "scheduled_plan_price_id") REFERENCES "plan_price"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE customer_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_subscription_isolation ON customer_subscription
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The provider's states, as ours (src/modules/payments/payment-provider.ts).
ALTER TABLE customer_subscription ADD CONSTRAINT customer_subscription_status_check
  CHECK (status IN ('incomplete', 'active', 'past_due', 'ended'));
ALTER TABLE customer_subscription ADD CONSTRAINT customer_subscription_period_check
  CHECK (current_period_end > current_period_start);

-- Deleting a workspace cascades into its plans' prices and its subscriptions in no fixed order. These
-- keys are checked at commit, when the whole cascade is done; deleting a price a subscription uses
-- alone still fails, at commit.
ALTER TABLE customer_subscription ALTER CONSTRAINT customer_subscription_tenant_id_plan_price_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE customer_subscription ALTER CONSTRAINT customer_subscription_tenant_id_scheduled_plan_price_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- The ledger's journal kinds and accounts, with plans and credit packs (src/modules/payments/ledger.ts).
ALTER TABLE ledger_journal DROP CONSTRAINT ledger_journal_kind_check;
ALTER TABLE ledger_journal ADD CONSTRAINT ledger_journal_kind_check
  CHECK (kind IN ('order_billed', 'payment_received', 'provider_fee', 'refund', 'payout', 'reversal', 'plan_billed', 'pack_billed'));
ALTER TABLE ledger_line DROP CONSTRAINT ledger_line_account_check;
ALTER TABLE ledger_line ADD CONSTRAINT ledger_line_account_check
  CHECK (account IN (
    'customer_receivable', 'stripe_balance', 'outside_stripe', 'sales', 'tax_payable', 'provider_fees', 'partner_costs',
    'subscription_sales', 'credit_sales'
  ));
