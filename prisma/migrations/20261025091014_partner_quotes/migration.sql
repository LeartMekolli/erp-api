-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "may_pick_partner" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote" ADD COLUMN     "partner_cost" DECIMAL(18,2),
ADD COLUMN     "partner_id" UUID;

-- CreateIndex
CREATE INDEX "quote_tenant_id_partner_id_idx" ON "quote"("tenant_id", "partner_id");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The rules the service keeps, kept by the database too: a picked workshop always comes with what
-- it is paid for the job, and that is never negative.

ALTER TABLE quote
  ADD CONSTRAINT quote_partner_cost_with_partner CHECK ((partner_id IS NULL) = (partner_cost IS NULL)),
  ADD CONSTRAINT quote_partner_cost_valid CHECK (partner_cost IS NULL OR partner_cost >= 0);
