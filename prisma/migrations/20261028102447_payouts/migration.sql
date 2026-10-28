-- CreateTable
CREATE TABLE "payout" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "provider_transfer_id" TEXT,
    "failure" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "payout_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "payout_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_tenant_id_partner_id_idx" ON "payout"("tenant_id", "partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_tenant_id_id_key" ON "payout"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_tenant_id_provider_transfer_id_key" ON "payout"("tenant_id", "provider_transfer_id");

-- CreateIndex
CREATE INDEX "payout_job_tenant_id_assignment_id_idx" ON "payout_job"("tenant_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_job_payout_id_assignment_id_key" ON "payout_job"("payout_id", "assignment_id");

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_job" ADD CONSTRAINT "payout_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_job" ADD CONSTRAINT "payout_job_tenant_id_payout_id_fkey" FOREIGN KEY ("tenant_id", "payout_id") REFERENCES "payout"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_job" ADD CONSTRAINT "payout_job_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "job_assignment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Checked at commit, as the ledger's are: deleting a workspace cascades to its users and its payouts
-- in no set order.
ALTER TABLE payout ALTER CONSTRAINT payout_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE payout ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout FORCE ROW LEVEL SECURITY;
CREATE POLICY payout_isolation ON payout
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE payout_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_job FORCE ROW LEVEL SECURITY;
CREATE POLICY payout_job_isolation ON payout_job
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE payout ADD CONSTRAINT payout_status_check CHECK (status IN ('pending', 'paid', 'failed', 'reversed'));
ALTER TABLE payout ADD CONSTRAINT payout_amount_check CHECK (amount > 0);
-- Paid, or reversed after it was, means the provider made the transfer.
ALTER TABLE payout ADD CONSTRAINT payout_transfer_check
  CHECK (status NOT IN ('paid', 'reversed') OR provider_transfer_id IS NOT NULL);
ALTER TABLE payout_job ADD CONSTRAINT payout_job_amount_check CHECK (amount <> 0);
