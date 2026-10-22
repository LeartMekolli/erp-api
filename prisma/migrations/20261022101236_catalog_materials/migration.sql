-- CreateTable
CREATE TABLE "material" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priced_unit" TEXT NOT NULL,
    "density_g_cm3" DECIMAL(18,6),
    "price_source" TEXT NOT NULL,
    "feed_metal" TEXT,
    "addon_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "addon_amount" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "manual_price" DECIMAL(18,6),
    "fallback_price" DECIMAL(18,6),
    "currency" CHAR(3) NOT NULL,
    "override_price" DECIMAL(18,6),
    "override_reason" TEXT,
    "override_at" TIMESTAMP(3),
    "override_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "material_tenant_id_key_key" ON "material"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "material_tenant_id_id_key" ON "material"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "material" ADD CONSTRAINT "material_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).
ALTER TABLE material ENABLE ROW LEVEL SECURITY;
ALTER TABLE material FORCE ROW LEVEL SECURITY;

CREATE POLICY material_isolation ON material
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE material
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;
