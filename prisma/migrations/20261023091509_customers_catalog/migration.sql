-- AlterTable
ALTER TABLE "product" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "published" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "product_tenant_id_customer_id_idx" ON "product"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
