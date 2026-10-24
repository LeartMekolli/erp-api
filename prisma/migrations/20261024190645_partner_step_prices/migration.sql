-- CreateTable
CREATE TABLE "partner_step_price" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,
    "material_id" UUID,
    "failure_percent" DECIMAL(9,4) NOT NULL,
    "blocks" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_step_price_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_step_price_tenant_id_partner_id_idx" ON "partner_step_price"("tenant_id", "partner_id");

-- CreateIndex
CREATE INDEX "partner_step_price_tenant_id_step_type_id_idx" ON "partner_step_price"("tenant_id", "step_type_id");

-- CreateIndex
CREATE INDEX "partner_step_price_tenant_id_material_id_idx" ON "partner_step_price"("tenant_id", "material_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_step_price_partner_id_step_type_id_material_id_key" ON "partner_step_price"("partner_id", "step_type_id", "material_id");

-- AddForeignKey
ALTER TABLE "partner_step_price" ADD CONSTRAINT "partner_step_price_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_step_price" ADD CONSTRAINT "partner_step_price_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_step_price" ADD CONSTRAINT "partner_step_price_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_step_price" ADD CONSTRAINT "partner_step_price_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "material"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE partner_step_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_step_price FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_step_price_isolation ON partner_step_price
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE partner_step_price
  ADD CONSTRAINT partner_step_price_failure_percent_valid CHECK (failure_percent >= 0 AND failure_percent <= 100);
