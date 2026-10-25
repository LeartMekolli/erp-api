-- CreateTable
CREATE TABLE "partner_capacity_snapshot" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "date" DATE NOT NULL,
    "partner_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,
    "load" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "capacity_period" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_capacity_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_capacity_snapshot_tenant_id_partner_id_date_idx" ON "partner_capacity_snapshot"("tenant_id", "partner_id", "date");

-- CreateIndex
CREATE INDEX "partner_capacity_snapshot_tenant_id_step_type_id_idx" ON "partner_capacity_snapshot"("tenant_id", "step_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_capacity_snapshot_tenant_id_date_partner_id_step_ty_key" ON "partner_capacity_snapshot"("tenant_id", "date", "partner_id", "step_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_capacity_snapshot_tenant_id_id_key" ON "partner_capacity_snapshot"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "partner_capacity_snapshot" ADD CONSTRAINT "partner_capacity_snapshot_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_capacity_snapshot" ADD CONSTRAINT "partner_capacity_snapshot_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_capacity_snapshot" ADD CONSTRAINT "partner_capacity_snapshot_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE partner_capacity_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_capacity_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_capacity_snapshot_isolation ON partner_capacity_snapshot
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The rules the handler keeps, kept by the database too.

ALTER TABLE partner_capacity_snapshot
  ADD CONSTRAINT partner_capacity_snapshot_load_valid CHECK (load >= 0),
  ADD CONSTRAINT partner_capacity_snapshot_capacity_valid CHECK (capacity >= 1),
  ADD CONSTRAINT partner_capacity_snapshot_period_valid CHECK (capacity_period IN ('day', 'week'));
