-- CreateTable
CREATE TABLE "job_rating" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "group_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "shared_with_partner" BOOLEAN NOT NULL DEFAULT false,
    "rated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_rating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_rating_tenant_id_partner_id_created_at_idx" ON "job_rating"("tenant_id", "partner_id", "created_at");

-- CreateIndex
CREATE INDEX "job_rating_tenant_id_customer_id_idx" ON "job_rating"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_rating_tenant_id_group_id_key" ON "job_rating"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_rating_tenant_id_id_key" ON "job_rating"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "job_rating" ADD CONSTRAINT "job_rating_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_rating" ADD CONSTRAINT "job_rating_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_rating" ADD CONSTRAINT "job_rating_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_rating" ADD CONSTRAINT "job_rating_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE job_rating ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_rating FORCE ROW LEVEL SECURITY;

CREATE POLICY job_rating_isolation ON job_rating
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The rules the service keeps, kept by the database too: whole stars from 1 to 5, and a comment of at
-- most 2000 characters that is never blank.

ALTER TABLE job_rating
  ADD CONSTRAINT job_rating_stars_valid CHECK (stars BETWEEN 1 AND 5),
  ADD CONSTRAINT job_rating_comment_valid CHECK (comment IS NULL OR (length(btrim(comment)) BETWEEN 1 AND 2000));
