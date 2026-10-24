-- AlterTable
ALTER TABLE "transition" ADD COLUMN     "partner_id" UUID;

-- CreateIndex
CREATE INDEX "transition_tenant_id_partner_id_idx" ON "transition"("tenant_id", "partner_id");

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
