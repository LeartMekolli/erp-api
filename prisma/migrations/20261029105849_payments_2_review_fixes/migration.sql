-- AlterTable
ALTER TABLE "customer_subscription" ADD COLUMN     "provider_read_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "subscription_paid_period" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "provider_subscription_id" TEXT NOT NULL,
    "provider_invoice_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_paid_period_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscription_paid_period_tenant_id_provider_subscription_id_idx" ON "subscription_paid_period"("tenant_id", "provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_paid_period_tenant_id_customer_id_idx" ON "subscription_paid_period"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_paid_period_tenant_id_id_key" ON "subscription_paid_period"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_paid_period_tenant_id_provider_invoice_id_key" ON "subscription_paid_period"("tenant_id", "provider_invoice_id");

-- AddForeignKey
ALTER TABLE "subscription_paid_period" ADD CONSTRAINT "subscription_paid_period_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_paid_period" ADD CONSTRAINT "subscription_paid_period_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The `plans` backfill made each existing workspace's Starter 2 members without pay later, against
-- the ruling in src/modules/payments/plans/default-plan.ts: a free plan never refuses a team or terms
-- the workspace had before plans existed, until staff set its limits. Only Starters still exactly as
-- that backfill left them are fixed; one staff have edited is left alone.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    UPDATE plan SET member_limit = NULL, features = ARRAY['pay_later']::text[]
    WHERE is_default AND member_limit = 2 AND features = '{}'::text[] AND monthly_credits = 0 AND discount_percent = 0;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE subscription_paid_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_paid_period FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_paid_period_isolation ON subscription_paid_period
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE subscription_paid_period ADD CONSTRAINT subscription_paid_period_period_check
  CHECK (period_end > period_start);

-- Deleting a workspace cascades into its paid periods and its customers in no fixed order. This key
-- is checked at commit, when the whole cascade is done; deleting a customer with paid periods alone
-- still fails, at commit.
ALTER TABLE subscription_paid_period ALTER CONSTRAINT subscription_paid_period_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Append-only (ADR 0003). The workspace's cascading delete is let through by forbid_mutation.
SELECT make_append_only('subscription_paid_period');

-- The ledger's journal kinds and accounts, with a plan invoice below zero and the customer's balance
-- at the provider (src/modules/payments/ledger.ts).
ALTER TABLE ledger_journal DROP CONSTRAINT ledger_journal_kind_check;
ALTER TABLE ledger_journal ADD CONSTRAINT ledger_journal_kind_check
  CHECK (kind IN (
    'order_billed', 'payment_received', 'provider_fee', 'refund', 'payout', 'reversal', 'plan_billed', 'pack_billed',
    'plan_credited', 'credit_applied'
  ));
ALTER TABLE ledger_line DROP CONSTRAINT ledger_line_account_check;
ALTER TABLE ledger_line ADD CONSTRAINT ledger_line_account_check
  CHECK (account IN (
    'customer_receivable', 'stripe_balance', 'outside_stripe', 'sales', 'tax_payable', 'provider_fees', 'partner_costs',
    'subscription_sales', 'credit_sales', 'customer_credit'
  ));
