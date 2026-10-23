-- AlterTable
ALTER TABLE "quote" ADD COLUMN     "customer_id" UUID;

-- CreateIndex
CREATE INDEX "quote_tenant_id_customer_id_idx" ON "quote"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
