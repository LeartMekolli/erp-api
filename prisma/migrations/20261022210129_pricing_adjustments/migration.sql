-- CreateTable
CREATE TABLE "margin_override" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "category_id" UUID,
    "product_id" UUID,
    "margin_percent" DECIMAL(9,4) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "margin_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "min_quantity" INTEGER NOT NULL,
    "percent" DECIMAL(9,4) NOT NULL,

    CONSTRAINT "discount_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "percent" DECIMAL(9,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_speed" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surcharge_percent" DECIMAL(9,4) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_speed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "min_size_surcharge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "category_id" UUID,
    "measure" TEXT NOT NULL,
    "below" DECIMAL(18,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "min_size_surcharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "margin_override_category_id_key" ON "margin_override"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "margin_override_product_id_key" ON "margin_override"("product_id");

-- CreateIndex
CREATE INDEX "margin_override_tenant_id_idx" ON "margin_override"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "margin_override_tenant_id_category_id_key" ON "margin_override"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "margin_override_tenant_id_product_id_key" ON "margin_override"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "discount_tier_tenant_id_idx" ON "discount_tier"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "discount_tier_tenant_id_min_quantity_key" ON "discount_tier"("tenant_id", "min_quantity");

-- CreateIndex
CREATE UNIQUE INDEX "customer_group_tenant_id_key_key" ON "customer_group"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "customer_group_tenant_id_id_key" ON "customer_group"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_speed_tenant_id_key_key" ON "delivery_speed"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_speed_tenant_id_id_key" ON "delivery_speed"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "min_size_surcharge_tenant_id_idx" ON "min_size_surcharge"("tenant_id");

-- AddForeignKey
ALTER TABLE "margin_override" ADD CONSTRAINT "margin_override_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "margin_override" ADD CONSTRAINT "margin_override_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "category"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "margin_override" ADD CONSTRAINT "margin_override_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_tier" ADD CONSTRAINT "discount_tier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_speed" ADD CONSTRAINT "delivery_speed_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "min_size_surcharge" ADD CONSTRAINT "min_size_surcharge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "min_size_surcharge" ADD CONSTRAINT "min_size_surcharge_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "category"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A margin override belongs to exactly one category or one product.
ALTER TABLE margin_override
  ADD CONSTRAINT margin_override_one_target CHECK ((category_id IS NULL) <> (product_id IS NULL));

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE margin_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_override FORCE ROW LEVEL SECURITY;

CREATE POLICY margin_override_isolation ON margin_override
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE discount_tier ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_tier FORCE ROW LEVEL SECURITY;

CREATE POLICY discount_tier_isolation ON discount_tier
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE customer_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_group FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_group_isolation ON customer_group
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE delivery_speed ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_speed FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_speed_isolation ON delivery_speed
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE min_size_surcharge ENABLE ROW LEVEL SECURITY;
ALTER TABLE min_size_surcharge FORCE ROW LEVEL SECURITY;

CREATE POLICY min_size_surcharge_isolation ON min_size_surcharge
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
