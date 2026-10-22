-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required_measures" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "category_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file_version_id" UUID,
    "material_id" UUID,
    "sizing" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL,
    "default_value_id" UUID,
    "position" INTEGER NOT NULL,

    CONSTRAINT "product_option_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_value" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "product_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "product_option_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_tenant_id_key_key" ON "category"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "category_tenant_id_id_key" ON "category"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_key_key" ON "product"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_id_key" ON "product"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "product_option_group_tenant_id_idx" ON "product_option_group"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_group_product_id_group_id_key" ON "product_option_group"("product_id", "group_id");

-- CreateIndex
CREATE INDEX "product_option_value_tenant_id_idx" ON "product_option_value"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_value_product_id_value_id_key" ON "product_option_value"("product_id", "value_id");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "category"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "material"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_group" ADD CONSTRAINT "product_option_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_group" ADD CONSTRAINT "product_option_group_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_group" ADD CONSTRAINT "product_option_group_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "option_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_group" ADD CONSTRAINT "product_option_group_tenant_id_default_value_id_fkey" FOREIGN KEY ("tenant_id", "default_value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_value" ADD CONSTRAINT "product_option_value_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_value" ADD CONSTRAINT "product_option_value_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_value" ADD CONSTRAINT "product_option_value_tenant_id_value_id_fkey" FOREIGN KEY ("tenant_id", "value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE category ENABLE ROW LEVEL SECURITY;
ALTER TABLE category FORCE ROW LEVEL SECURITY;

CREATE POLICY category_isolation ON category
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE category
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE ROW LEVEL SECURITY;

CREATE POLICY product_isolation ON product
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE product
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE product_option_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_option_group FORCE ROW LEVEL SECURITY;

CREATE POLICY product_option_group_isolation ON product_option_group
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE product_option_group
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE product_option_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_option_value FORCE ROW LEVEL SECURITY;

CREATE POLICY product_option_value_isolation ON product_option_value
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE product_option_value
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;
