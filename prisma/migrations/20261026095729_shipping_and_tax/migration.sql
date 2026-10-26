-- CreateTable
CREATE TABLE "shipping_method" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "country" CHAR(2),
    "region" TEXT,
    "percent" DECIMAL(9,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_method_tenant_id_key_key" ON "shipping_method"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_method_tenant_id_id_key" ON "shipping_method"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "tax_rate_tenant_id_country_idx" ON "tax_rate"("tenant_id", "country");

-- AddForeignKey
ALTER TABLE "shipping_method" ADD CONSTRAINT "shipping_method_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same rules the API applies (Orders spec, goals 9 and 10).
ALTER TABLE shipping_method
  ADD CONSTRAINT shipping_method_price_not_negative CHECK (price >= 0);
ALTER TABLE tax_rate
  ADD CONSTRAINT tax_rate_percent_range CHECK (percent BETWEEN 0 AND 100),
  ADD CONSTRAINT tax_rate_country_code CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT tax_rate_region_needs_country CHECK (region IS NULL OR country IS NOT NULL);
-- One rate per place is kept by replacing the whole list under a lock: Prisma's schema can't hold the
-- NULLS NOT DISTINCT unique index it would need, and would drop one it doesn't know of.

ALTER TABLE shipping_method ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_method FORCE ROW LEVEL SECURITY;
CREATE POLICY shipping_method_isolation ON shipping_method
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE tax_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rate FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_rate_isolation ON tax_rate
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
