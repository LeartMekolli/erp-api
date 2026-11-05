-- AlterTable
ALTER TABLE "order" ADD COLUMN     "payment_state" TEXT,
ADD COLUMN     "state" TEXT;

-- CreateIndex
CREATE INDEX "order_tenant_id_state_promised_on_id_idx" ON "order"("tenant_id", "state", "promised_on", "id");

-- CreateIndex
CREATE INDEX "order_tenant_id_payment_state_idx" ON "order"("tenant_id", "payment_state");

-- CreateIndex
CREATE INDEX "order_tenant_id_promised_on_id_idx" ON "order"("tenant_id", "promised_on", "id");
