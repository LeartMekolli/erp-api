-- CreateTable
CREATE TABLE "transition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "work_order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT,
    "from_step_id" UUID,
    "to_step_id" UUID,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "defect_id" UUID,
    "override_reason" TEXT,
    "comment" TEXT,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transition_answer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "transition_id" UUID NOT NULL,
    "item_key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "passing" BOOLEAN NOT NULL,

    CONSTRAINT "transition_answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transition_photo" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "transition_id" UUID NOT NULL,
    "file_version_id" UUID NOT NULL,

    CONSTRAINT "transition_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transition_tenant_id_work_order_id_id_idx" ON "transition"("tenant_id", "work_order_id", "id");

-- CreateIndex
CREATE INDEX "transition_tenant_id_created_at_idx" ON "transition"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "transition_tenant_id_from_step_id_idx" ON "transition"("tenant_id", "from_step_id");

-- CreateIndex
CREATE INDEX "transition_tenant_id_to_step_id_idx" ON "transition"("tenant_id", "to_step_id");

-- CreateIndex
CREATE INDEX "transition_tenant_id_defect_id_idx" ON "transition"("tenant_id", "defect_id");

-- CreateIndex
CREATE INDEX "transition_tenant_id_actor_user_id_idx" ON "transition"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "transition_tenant_id_id_key" ON "transition"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "transition_answer_tenant_id_transition_id_idx" ON "transition_answer"("tenant_id", "transition_id");

-- CreateIndex
CREATE INDEX "transition_photo_tenant_id_transition_id_idx" ON "transition_photo"("tenant_id", "transition_id");

-- CreateIndex
CREATE INDEX "transition_photo_tenant_id_file_version_id_idx" ON "transition_photo"("tenant_id", "file_version_id");

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_work_order_id_fkey" FOREIGN KEY ("tenant_id", "work_order_id") REFERENCES "work_order"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_from_step_id_fkey" FOREIGN KEY ("tenant_id", "from_step_id") REFERENCES "workflow_step"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_to_step_id_fkey" FOREIGN KEY ("tenant_id", "to_step_id") REFERENCES "workflow_step"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_defect_id_fkey" FOREIGN KEY ("tenant_id", "defect_id") REFERENCES "defect"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition" ADD CONSTRAINT "transition_tenant_id_actor_user_id_fkey" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_answer" ADD CONSTRAINT "transition_answer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_answer" ADD CONSTRAINT "transition_answer_tenant_id_transition_id_fkey" FOREIGN KEY ("tenant_id", "transition_id") REFERENCES "transition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_photo" ADD CONSTRAINT "transition_photo_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_photo" ADD CONSTRAINT "transition_photo_tenant_id_transition_id_fkey" FOREIGN KEY ("tenant_id", "transition_id") REFERENCES "transition"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_photo" ADD CONSTRAINT "transition_photo_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE transition
  ADD CONSTRAINT transition_kind_valid CHECK (kind IN ('pass', 'fail', 'correction')),
  ADD CONSTRAINT transition_outcome_only_on_fail CHECK ((kind = 'fail') = (outcome IS NOT NULL)),
  ADD CONSTRAINT transition_outcome_valid CHECK (outcome IN ('rework', 'scrap', 'continue'));

ALTER TABLE transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE transition FORCE ROW LEVEL SECURITY;
CREATE POLICY transition_isolation ON transition
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE transition_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE transition_answer FORCE ROW LEVEL SECURITY;
CREATE POLICY transition_answer_isolation ON transition_answer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE transition_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE transition_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY transition_photo_isolation ON transition_photo
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- These are the first append-only tables with foreign keys, so deleting a workspace cascades a
-- DELETE into them. A cascade runs inside the foreign key's own trigger, so it is let through
-- there (depth above 1); a DELETE issued directly, and every UPDATE and TRUNCATE, stays refused
-- for everyone, the owner included. Transitions can't be deleted through their work order:
-- that key is NO ACTION.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501', HINT = 'Insert a correcting row instead.';
END;
$$;

SELECT make_append_only('transition');
SELECT make_append_only('transition_answer');
SELECT make_append_only('transition_photo');
