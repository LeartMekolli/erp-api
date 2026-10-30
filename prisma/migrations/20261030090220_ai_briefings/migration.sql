-- CreateTable
CREATE TABLE "ai_briefing" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "run_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_briefing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "briefing_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "targets" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "ai_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestion_dismissal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targets" JSONB NOT NULL,
    "dismissed_by_user_id" UUID NOT NULL,
    "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestion_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_briefing_run_id_key" ON "ai_briefing"("run_id");

-- CreateIndex
CREATE INDEX "ai_briefing_tenant_id_created_at_idx" ON "ai_briefing"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_briefing_tenant_id_run_id_key" ON "ai_briefing"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_briefing_tenant_id_id_key" ON "ai_briefing"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ai_suggestion_tenant_id_briefing_id_idx" ON "ai_suggestion"("tenant_id", "briefing_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_suggestion_dismissal_tenant_id_fingerprint_key" ON "ai_suggestion_dismissal"("tenant_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "ai_briefing" ADD CONSTRAINT "ai_briefing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_briefing" ADD CONSTRAINT "ai_briefing_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "ai_run"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_tenant_id_briefing_id_fkey" FOREIGN KEY ("tenant_id", "briefing_id") REFERENCES "ai_briefing"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion_dismissal" ADD CONSTRAINT "ai_suggestion_dismissal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestion_dismissal" ADD CONSTRAINT "ai_suggestion_dismissal_tenant_id_dismissed_by_user_id_fkey" FOREIGN KEY ("tenant_id", "dismissed_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (AI 1 plan, Task 8): row-level security, checks and keys checked at commit.

ALTER TABLE ai_briefing ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_briefing FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_briefing_isolation ON ai_briefing
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE ai_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_suggestion_isolation ON ai_suggestion
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE ai_suggestion_dismissal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion_dismissal FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_suggestion_dismissal_isolation ON ai_suggestion_dismissal
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The kinds of SUGGESTION_TARGETS in src/modules/ai/suggestions.ts.
ALTER TABLE ai_suggestion ADD CONSTRAINT ai_suggestion_kind_check
  CHECK (kind IN ('offer_job', 'chase_invoice', 'release_order', 'contact_customer', 'review_partner', 'review_step'));
ALTER TABLE ai_suggestion_dismissal ADD CONSTRAINT ai_suggestion_dismissal_kind_check
  CHECK (kind IN ('offer_job', 'chase_invoice', 'release_order', 'contact_customer', 'review_partner', 'review_step'));
ALTER TABLE ai_suggestion ADD CONSTRAINT ai_suggestion_position_check CHECK (position BETWEEN 0 AND 4);
ALTER TABLE ai_suggestion ADD CONSTRAINT ai_suggestion_targets_check CHECK (jsonb_typeof(targets) = 'array');
ALTER TABLE ai_suggestion_dismissal ADD CONSTRAINT ai_suggestion_dismissal_targets_check CHECK (jsonb_typeof(targets) = 'array');

-- Deleting a workspace cascades into its runs, briefings, suggestions and users in no fixed order. These
-- keys are checked at commit, when the whole cascade is done.
ALTER TABLE ai_briefing ALTER CONSTRAINT ai_briefing_tenant_id_run_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_suggestion ALTER CONSTRAINT ai_suggestion_tenant_id_briefing_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_suggestion_dismissal ALTER CONSTRAINT ai_suggestion_dismissal_tenant_id_dismissed_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
