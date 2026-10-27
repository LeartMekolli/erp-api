-- CreateTable
CREATE TABLE "assembly_part" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "assembly_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "size" JSONB,

    CONSTRAINT "assembly_part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assembly_part_tenant_id_idx" ON "assembly_part"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "assembly_part_tenant_id_assembly_id_part_id_key" ON "assembly_part"("tenant_id", "assembly_id", "part_id");

-- AddForeignKey
ALTER TABLE "assembly_part" ADD CONSTRAINT "assembly_part_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_part" ADD CONSTRAINT "assembly_part_tenant_id_assembly_id_fkey" FOREIGN KEY ("tenant_id", "assembly_id") REFERENCES "product"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assembly_part" ADD CONSTRAINT "assembly_part_tenant_id_part_id_fkey" FOREIGN KEY ("tenant_id", "part_id") REFERENCES "product"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE assembly_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE assembly_part FORCE ROW LEVEL SECURITY;

CREATE POLICY assembly_part_isolation ON assembly_part
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE assembly_part
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- The rules the service keeps, kept by the database too (Orders spec, goal 6): a part is never its
-- own assembly, 1 to 100 of it go into one, and positions count from 0.
ALTER TABLE assembly_part
  ADD CONSTRAINT assembly_part_not_itself CHECK (assembly_id <> part_id),
  ADD CONSTRAINT assembly_part_quantity_valid CHECK (quantity BETWEEN 1 AND 100),
  ADD CONSTRAINT assembly_part_position_valid CHECK (position >= 0);
