-- CreateTable
CREATE TABLE "report_week" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "week_start" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_week_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_week_tenant_id_week_start_key" ON "report_week"("tenant_id", "week_start");

-- AddForeignKey
ALTER TABLE "report_week" ADD CONSTRAINT "report_week_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE report_week ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_week FORCE ROW LEVEL SECURITY;
CREATE POLICY report_week_isolation ON report_week
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The week starts on a Monday (ISO weekday 1).
ALTER TABLE report_week ADD CONSTRAINT report_week_monday_check CHECK (EXTRACT(ISODOW FROM week_start) = 1);
