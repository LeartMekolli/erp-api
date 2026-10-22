-- CreateTable
CREATE TABLE "category_step" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "category_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,

    CONSTRAINT "category_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_chain" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "product_id" UUID NOT NULL,

    CONSTRAINT "product_chain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_step" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "product_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,

    CONSTRAINT "product_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_step_effect" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "value_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,
    "effect" TEXT NOT NULL,

    CONSTRAINT "option_step_effect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_step_tenant_id_idx" ON "category_step"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_step_category_id_step_type_id_key" ON "category_step"("category_id", "step_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_chain_product_id_key" ON "product_chain"("product_id");

-- CreateIndex
CREATE INDEX "product_chain_tenant_id_idx" ON "product_chain"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_chain_tenant_id_product_id_key" ON "product_chain"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "product_step_tenant_id_idx" ON "product_step"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_step_product_id_step_type_id_key" ON "product_step"("product_id", "step_type_id");

-- CreateIndex
CREATE INDEX "option_step_effect_tenant_id_idx" ON "option_step_effect"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "option_step_effect_value_id_step_type_id_key" ON "option_step_effect"("value_id", "step_type_id");

-- AddForeignKey
ALTER TABLE "category_step" ADD CONSTRAINT "category_step_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_step" ADD CONSTRAINT "category_step_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "category"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_step" ADD CONSTRAINT "category_step_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_chain" ADD CONSTRAINT "product_chain_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_chain" ADD CONSTRAINT "product_chain_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_step" ADD CONSTRAINT "product_step_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_step" ADD CONSTRAINT "product_step_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_step" ADD CONSTRAINT "product_step_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_step_effect" ADD CONSTRAINT "option_step_effect_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_step_effect" ADD CONSTRAINT "option_step_effect_tenant_id_value_id_fkey" FOREIGN KEY ("tenant_id", "value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_step_effect" ADD CONSTRAINT "option_step_effect_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE category_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_step FORCE ROW LEVEL SECURITY;

CREATE POLICY category_step_isolation ON category_step
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE product_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_chain FORCE ROW LEVEL SECURITY;

CREATE POLICY product_chain_isolation ON product_chain
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE product_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_step FORCE ROW LEVEL SECURITY;

CREATE POLICY product_step_isolation ON product_step
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE option_step_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_step_effect FORCE ROW LEVEL SECURITY;

CREATE POLICY option_step_effect_isolation ON option_step_effect
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
