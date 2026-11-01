-- AlterTable
ALTER TABLE "transition" ADD COLUMN     "inspected" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "skill" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_skill" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "user_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "expires_on" DATE,
    "granted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_skill_pkey" PRIMARY KEY ("tenant_id","user_id","skill_id")
);

-- CreateTable
CREATE TABLE "sample_draw" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "group_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "drawn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_by_transition_id" UUID,

    CONSTRAINT "sample_draw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_piece" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "draw_id" UUID NOT NULL,
    "work_order_id" UUID NOT NULL,

    CONSTRAINT "sample_piece_pkey" PRIMARY KEY ("tenant_id","draw_id","work_order_id")
);

-- CreateTable
CREATE TABLE "order_progress_email" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "step_name" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_progress_email_pkey" PRIMARY KEY ("tenant_id","order_id","step_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_tenant_id_id_key" ON "skill"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "user_skill_tenant_id_skill_id_idx" ON "user_skill"("tenant_id", "skill_id");

-- CreateIndex
CREATE INDEX "user_skill_tenant_id_granted_by_user_id_idx" ON "user_skill"("tenant_id", "granted_by_user_id");

-- CreateIndex
CREATE INDEX "sample_draw_tenant_id_step_id_idx" ON "sample_draw"("tenant_id", "step_id");

-- CreateIndex
CREATE INDEX "sample_draw_tenant_id_ended_by_transition_id_idx" ON "sample_draw"("tenant_id", "ended_by_transition_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_draw_tenant_id_group_id_step_id_key" ON "sample_draw"("tenant_id", "group_id", "step_id");

-- CreateIndex
CREATE UNIQUE INDEX "sample_draw_tenant_id_id_key" ON "sample_draw"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sample_piece_tenant_id_work_order_id_idx" ON "sample_piece"("tenant_id", "work_order_id");

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_tenant_id_skill_id_fkey" FOREIGN KEY ("tenant_id", "skill_id") REFERENCES "skill"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_skill" ADD CONSTRAINT "user_skill_tenant_id_granted_by_user_id_fkey" FOREIGN KEY ("tenant_id", "granted_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_draw" ADD CONSTRAINT "sample_draw_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_draw" ADD CONSTRAINT "sample_draw_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_draw" ADD CONSTRAINT "sample_draw_tenant_id_step_id_fkey" FOREIGN KEY ("tenant_id", "step_id") REFERENCES "workflow_step"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_draw" ADD CONSTRAINT "sample_draw_tenant_id_ended_by_transition_id_fkey" FOREIGN KEY ("tenant_id", "ended_by_transition_id") REFERENCES "transition"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_piece" ADD CONSTRAINT "sample_piece_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_piece" ADD CONSTRAINT "sample_piece_tenant_id_draw_id_fkey" FOREIGN KEY ("tenant_id", "draw_id") REFERENCES "sample_draw"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_piece" ADD CONSTRAINT "sample_piece_tenant_id_work_order_id_fkey" FOREIGN KEY ("tenant_id", "work_order_id") REFERENCES "work_order"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_progress_email" ADD CONSTRAINT "order_progress_email_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_progress_email" ADD CONSTRAINT "order_progress_email_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Workflow 2 plan, Task 1): row-level security, checks, and keys checked at commit.
ALTER TABLE skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_isolation ON skill
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE user_skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_skill FORCE ROW LEVEL SECURITY;
CREATE POLICY user_skill_isolation ON user_skill
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE sample_draw ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_draw FORCE ROW LEVEL SECURITY;
CREATE POLICY sample_draw_isolation ON sample_draw
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE sample_piece ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_piece FORCE ROW LEVEL SECURITY;
CREATE POLICY sample_piece_isolation ON sample_piece
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_progress_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_progress_email FORCE ROW LEVEL SECURITY;
CREATE POLICY order_progress_email_isolation ON order_progress_email
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- A skill name is unique per workspace regardless of case, and never blank or padded.
CREATE UNIQUE INDEX skill_tenant_id_lower_name_key ON skill (tenant_id, lower(name));
ALTER TABLE skill ADD CONSTRAINT skill_name_check CHECK (name = btrim(name) AND name <> '' AND length(name) <= 100);
-- A draw ends with the fail that ended it, both or neither.
ALTER TABLE sample_draw ADD CONSTRAINT sample_draw_ended_check
  CHECK ((ended_at IS NULL) = (ended_by_transition_id IS NULL));
ALTER TABLE order_progress_email ADD CONSTRAINT order_progress_email_step_name_check CHECK (step_name <> '');

-- Deleting a workspace cascades into these rows and what they point at in no fixed order. These keys
-- are checked at commit, when the whole cascade is done.
ALTER TABLE user_skill ALTER CONSTRAINT user_skill_tenant_id_granted_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sample_draw ALTER CONSTRAINT sample_draw_tenant_id_step_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sample_draw ALTER CONSTRAINT sample_draw_tenant_id_ended_by_transition_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE sample_piece ALTER CONSTRAINT sample_piece_tenant_id_work_order_id_fkey DEFERRABLE INITIALLY DEFERRED;
