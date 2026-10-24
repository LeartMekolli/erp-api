-- CreateTable
CREATE TABLE "job_assignment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "group_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "owed_override" DECIMAL(18,2),
    "owed_override_reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_assignment_tenant_id_group_id_idx" ON "job_assignment"("tenant_id", "group_id");

-- CreateIndex
CREATE INDEX "job_assignment_tenant_id_partner_id_status_idx" ON "job_assignment"("tenant_id", "partner_id", "status");

-- CreateIndex
CREATE INDEX "job_assignment_status_expires_at_idx" ON "job_assignment"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_assignment_tenant_id_id_key" ON "job_assignment"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_assignment" ADD CONSTRAINT "job_assignment_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE job_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY job_assignment_isolation ON job_assignment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The rules the service keeps, kept by the database too. One open row per group is kept under the
-- group row lock (src/modules/partners/jobs.service.ts); Prisma can't express a partial unique index.

ALTER TABLE job_assignment
  ADD CONSTRAINT job_assignment_kind_valid CHECK (kind IN ('offer', 'direct', 'reassign')),
  ADD CONSTRAINT job_assignment_status_valid
    CHECK (status IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn', 'replaced')),
  ADD CONSTRAINT job_assignment_offer_expires CHECK (kind <> 'offer' OR expires_at IS NOT NULL),
  ADD CONSTRAINT job_assignment_amounts_valid CHECK (cost >= 0 AND (owed_override IS NULL OR owed_override >= 0)),
  ADD CONSTRAINT job_assignment_override_reason CHECK ((owed_override IS NULL) = (owed_override_reason IS NULL));
