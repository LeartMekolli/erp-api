-- CreateTable
CREATE TABLE "ledger_journal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "order_id" UUID,
    "customer_id" UUID,
    "partner_id" UUID,
    "payout_id" UUID,
    "refund_id" UUID,
    "provider_object_id" TEXT,
    "reverses_journal_id" UUID,
    "created_by_user_id" UUID,
    "memo" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "journal_id" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "customer_id" UUID,
    "partner_id" UUID,

    CONSTRAINT "ledger_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_journal_tenant_id_customer_id_idx" ON "ledger_journal"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "ledger_journal_tenant_id_partner_id_idx" ON "ledger_journal"("tenant_id", "partner_id");

-- CreateIndex
CREATE INDEX "ledger_journal_tenant_id_order_id_idx" ON "ledger_journal"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journal_tenant_id_id_key" ON "ledger_journal"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journal_tenant_id_kind_provider_object_id_key" ON "ledger_journal"("tenant_id", "kind", "provider_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_journal_tenant_id_reverses_journal_id_key" ON "ledger_journal"("tenant_id", "reverses_journal_id");

-- CreateIndex
CREATE INDEX "ledger_line_tenant_id_journal_id_idx" ON "ledger_line"("tenant_id", "journal_id");

-- CreateIndex
CREATE INDEX "ledger_line_tenant_id_account_customer_id_idx" ON "ledger_line"("tenant_id", "account", "customer_id");

-- CreateIndex
CREATE INDEX "ledger_line_tenant_id_account_partner_id_idx" ON "ledger_line"("tenant_id", "account", "partner_id");

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_journal" ADD CONSTRAINT "ledger_journal_tenant_id_reverses_journal_id_fkey" FOREIGN KEY ("tenant_id", "reverses_journal_id") REFERENCES "ledger_journal"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_tenant_id_journal_id_fkey" FOREIGN KEY ("tenant_id", "journal_id") REFERENCES "ledger_journal"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_line" ADD CONSTRAINT "ledger_line_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE ledger_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_journal_isolation ON ledger_journal
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE ledger_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_line FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_line_isolation ON ledger_line
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The chart of accounts and the journal kinds (src/modules/payments/ledger.ts), and no line of zero.
ALTER TABLE ledger_journal ADD CONSTRAINT ledger_journal_kind_check
  CHECK (kind IN ('order_billed', 'payment_received', 'provider_fee', 'refund', 'payout', 'reversal'));
ALTER TABLE ledger_line ADD CONSTRAINT ledger_line_account_check
  CHECK (account IN ('customer_receivable', 'stripe_balance', 'outside_stripe', 'sales', 'tax_payable', 'provider_fees', 'partner_costs'));
ALTER TABLE ledger_line ADD CONSTRAINT ledger_line_amount_check CHECK (amount <> 0);

-- A journal balances: at least two lines, summing to exactly zero. Checked at commit, so a journal and
-- its lines can be written in any order within one transaction. It runs for each line and for the
-- journal itself, which also refuses a journal that never gets lines.
CREATE OR REPLACE FUNCTION ledger_journal_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  total numeric;
  line_count bigint;
BEGIN
  -- An IF, not a CASE: both branches of a CASE are resolved against NEW, and a journal has no journal_id.
  IF TG_TABLE_NAME = 'ledger_journal' THEN
    target := NEW.id;
  ELSE
    target := NEW.journal_id;
  END IF;
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, line_count
  FROM ledger_line WHERE journal_id = target;
  IF line_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger journal % does not balance: % lines summing to %', target, line_count, total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_line_journal_balances
  AFTER INSERT ON ledger_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balances();

CREATE CONSTRAINT TRIGGER ledger_journal_has_balanced_lines
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balances();

-- Deleting a workspace cascades into the ledger and into the customers, partners and orders it
-- points at, in no fixed order. These keys refuse to remove what a journal points at, so they are
-- checked at commit, when the whole cascade is done, instead of after each step. Deleting a
-- customer, partner or order that has journals alone still fails, at commit.
ALTER TABLE ledger_journal ALTER CONSTRAINT ledger_journal_tenant_id_order_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_journal ALTER CONSTRAINT ledger_journal_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_journal ALTER CONSTRAINT ledger_journal_tenant_id_partner_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_journal ALTER CONSTRAINT ledger_journal_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_journal ALTER CONSTRAINT ledger_journal_tenant_id_reverses_journal_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_line ALTER CONSTRAINT ledger_line_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledger_line ALTER CONSTRAINT ledger_line_tenant_id_partner_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Append-only (ADR 0003). The workspace's cascading delete is let through by forbid_mutation.
SELECT make_append_only('ledger_journal');
SELECT make_append_only('ledger_line');
