-- CreateTable
CREATE TABLE "credit_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "source_key" TEXT NOT NULL,
    "campaign_id" UUID,
    "pack_purchase_id" UUID,
    "created_by_user_id" UUID,
    "reason" TEXT,

    CONSTRAINT "credit_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_spend" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "gives_back_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "spend_id" UUID,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_grant_tenant_id_customer_id_expires_at_idx" ON "credit_grant"("tenant_id", "customer_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grant_tenant_id_id_key" ON "credit_grant"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_grant_tenant_id_source_key_key" ON "credit_grant"("tenant_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_spend_tenant_id_id_key" ON "credit_spend"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_spend_tenant_id_customer_id_reference_key" ON "credit_spend"("tenant_id", "customer_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "credit_spend_tenant_id_gives_back_id_key" ON "credit_spend"("tenant_id", "gives_back_id");

-- CreateIndex
CREATE INDEX "credit_entry_tenant_id_customer_id_id_idx" ON "credit_entry"("tenant_id", "customer_id", "id");

-- CreateIndex
CREATE INDEX "credit_entry_tenant_id_grant_id_idx" ON "credit_entry"("tenant_id", "grant_id");

-- CreateIndex
CREATE INDEX "credit_entry_tenant_id_spend_id_idx" ON "credit_entry"("tenant_id", "spend_id");

-- AddForeignKey
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_spend" ADD CONSTRAINT "credit_spend_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_spend" ADD CONSTRAINT "credit_spend_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_spend" ADD CONSTRAINT "credit_spend_tenant_id_gives_back_id_fkey" FOREIGN KEY ("tenant_id", "gives_back_id") REFERENCES "credit_spend"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_tenant_id_grant_id_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "credit_grant"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_tenant_id_spend_id_fkey" FOREIGN KEY ("tenant_id", "spend_id") REFERENCES "credit_spend"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE credit_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_grant_isolation ON credit_grant
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE credit_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_spend FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_spend_isolation ON credit_spend
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE credit_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_entry_isolation ON credit_entry
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Sources and kinds (src/modules/payments/credits/credit-ledger.ts). Credits are whole and never
-- negative on a grant or a spend; an entry is never zero, and its sign follows its kind.
ALTER TABLE credit_grant ADD CONSTRAINT credit_grant_source_check
  CHECK (source IN ('allowance', 'pack', 'campaign', 'staff'));
ALTER TABLE credit_grant ADD CONSTRAINT credit_grant_amount_check CHECK (amount > 0);

ALTER TABLE credit_spend ADD CONSTRAINT credit_spend_kind_check CHECK (kind IN ('spend', 'give_back'));
ALTER TABLE credit_spend ADD CONSTRAINT credit_spend_amount_check CHECK (amount > 0);
-- A spend has the caller's reference; a give-back has none, and names the spend it returns.
ALTER TABLE credit_spend ADD CONSTRAINT credit_spend_shape_check CHECK (
  (kind = 'spend' AND reference IS NOT NULL AND gives_back_id IS NULL)
  OR (kind = 'give_back' AND reference IS NULL AND gives_back_id IS NOT NULL)
);

ALTER TABLE credit_entry ADD CONSTRAINT credit_entry_kind_check
  CHECK (kind IN ('grant', 'spend', 'give_back', 'expire'));
ALTER TABLE credit_entry ADD CONSTRAINT credit_entry_amount_check CHECK (
  (kind IN ('grant', 'give_back') AND amount > 0)
  OR (kind IN ('spend', 'expire') AND amount < 0)
);
-- Spends and give-backs belong to a spend row; grants and expiries don't.
ALTER TABLE credit_entry ADD CONSTRAINT credit_entry_spend_check CHECK (
  (kind IN ('spend', 'give_back')) = (spend_id IS NOT NULL)
);

-- Deleting a workspace cascades into the credit tables and the customers and users they point at,
-- in no fixed order. These keys are checked at commit, when the whole cascade is done. Deleting a
-- customer or user that has credits alone still fails, at commit.
ALTER TABLE credit_grant ALTER CONSTRAINT credit_grant_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_grant ALTER CONSTRAINT credit_grant_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_spend ALTER CONSTRAINT credit_spend_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_spend ALTER CONSTRAINT credit_spend_tenant_id_gives_back_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_entry ALTER CONSTRAINT credit_entry_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Append-only (ADR 0003). The workspace's cascading delete is let through by forbid_mutation.
SELECT make_append_only('credit_grant');
SELECT make_append_only('credit_spend');
SELECT make_append_only('credit_entry');
