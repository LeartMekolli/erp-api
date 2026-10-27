-- AlterTable
ALTER TABLE "work_order_group" ADD COLUMN     "parent_group_id" UUID;

-- CreateTable
CREATE TABLE "order_line_part" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "line_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quote_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "group_id" UUID,

    CONSTRAINT "order_line_part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_line_part_tenant_id_idx" ON "order_line_part"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_part_tenant_id_quote_id_key" ON "order_line_part"("tenant_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_part_tenant_id_group_id_key" ON "order_line_part"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_part_line_id_position_key" ON "order_line_part"("line_id", "position");

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_parent_group_id_fkey" FOREIGN KEY ("tenant_id", "parent_group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_part" ADD CONSTRAINT "order_line_part_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_part" ADD CONSTRAINT "order_line_part_tenant_id_line_id_fkey" FOREIGN KEY ("tenant_id", "line_id") REFERENCES "order_line"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_part" ADD CONSTRAINT "order_line_part_tenant_id_quote_id_fkey" FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quote"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_part" ADD CONSTRAINT "order_line_part_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_part" ADD CONSTRAINT "order_line_part_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE order_line_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_part FORCE ROW LEVEL SECURITY;

CREATE POLICY order_line_part_isolation ON order_line_part
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_line_part
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- The rules the service keeps, kept by the database too (Orders spec, goals 6 and 11): positions
-- count from 0, a part has pieces, and amounts are never negative.
ALTER TABLE order_line_part
  ADD CONSTRAINT order_line_part_position_valid CHECK (position >= 0),
  ADD CONSTRAINT order_line_part_quantity_valid CHECK (quantity >= 1),
  ADD CONSTRAINT order_line_part_amounts_valid CHECK (unit_price >= 0 AND total >= 0);

-- A group is never its own part.
ALTER TABLE work_order_group
  ADD CONSTRAINT work_order_group_not_own_part CHECK (parent_group_id IS NULL OR parent_group_id <> id);
