-- AlterTable
ALTER TABLE "partner" ADD COLUMN     "max_open_jobs" INTEGER,
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "partner_capability" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "step_type_id" UUID NOT NULL,
    "min_quantity" INTEGER NOT NULL DEFAULT 1,
    "max_quantity" INTEGER,
    "max_size_mm" DECIMAL(18,6),
    "capacity" INTEGER NOT NULL,
    "capacity_period" TEXT NOT NULL,

    CONSTRAINT "partner_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_closed_period" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "note" TEXT,

    CONSTRAINT "partner_closed_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_offering" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "option_value_id" UUID NOT NULL,

    CONSTRAINT "partner_offering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_capability_tenant_id_partner_id_idx" ON "partner_capability"("tenant_id", "partner_id");

-- CreateIndex
CREATE INDEX "partner_capability_tenant_id_step_type_id_idx" ON "partner_capability"("tenant_id", "step_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_capability_partner_id_step_type_id_key" ON "partner_capability"("partner_id", "step_type_id");

-- CreateIndex
CREATE INDEX "partner_closed_period_tenant_id_partner_id_idx" ON "partner_closed_period"("tenant_id", "partner_id");

-- CreateIndex
CREATE INDEX "partner_offering_tenant_id_partner_id_idx" ON "partner_offering"("tenant_id", "partner_id");

-- CreateIndex
CREATE INDEX "partner_offering_tenant_id_option_value_id_idx" ON "partner_offering"("tenant_id", "option_value_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_offering_partner_id_option_value_id_key" ON "partner_offering"("partner_id", "option_value_id");

-- AddForeignKey
ALTER TABLE "partner_capability" ADD CONSTRAINT "partner_capability_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_capability" ADD CONSTRAINT "partner_capability_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_capability" ADD CONSTRAINT "partner_capability_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_closed_period" ADD CONSTRAINT "partner_closed_period_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_closed_period" ADD CONSTRAINT "partner_closed_period_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_offering" ADD CONSTRAINT "partner_offering_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_offering" ADD CONSTRAINT "partner_offering_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_offering" ADD CONSTRAINT "partner_offering_tenant_id_option_value_id_fkey" FOREIGN KEY ("tenant_id", "option_value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE partner_capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_capability FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_capability_isolation ON partner_capability
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE partner_closed_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_closed_period FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_closed_period_isolation ON partner_closed_period
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE partner_offering ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_offering FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_offering_isolation ON partner_offering
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The rules the API checks, kept by the database too.

ALTER TABLE partner_capability
  ADD CONSTRAINT partner_capability_quantities_valid CHECK (min_quantity >= 1 AND (max_quantity IS NULL OR max_quantity >= min_quantity)),
  ADD CONSTRAINT partner_capability_capacity_valid CHECK (capacity >= 1 AND capacity_period IN ('day', 'week')),
  ADD CONSTRAINT partner_capability_size_valid CHECK (max_size_mm IS NULL OR max_size_mm > 0);

ALTER TABLE partner_closed_period
  ADD CONSTRAINT partner_closed_period_dates_valid CHECK (ends_on >= starts_on);

ALTER TABLE partner
  ADD CONSTRAINT partner_max_open_jobs_valid CHECK (max_open_jobs IS NULL OR max_open_jobs >= 1);
