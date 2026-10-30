-- CreateTable
CREATE TABLE "ai_customer_result" (
    "run_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "spend_id" UUID NOT NULL,
    "parent_id" UUID,
    "file_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,

    CONSTRAINT "ai_customer_result_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "ai_customer_result_tenant_id_customer_id_run_id_idx" ON "ai_customer_result"("tenant_id", "customer_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_customer_result_tenant_id_run_id_key" ON "ai_customer_result"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_customer_result_tenant_id_spend_id_key" ON "ai_customer_result"("tenant_id", "spend_id");

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "ai_run"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_spend_id_fkey" FOREIGN KEY ("tenant_id", "spend_id") REFERENCES "credit_spend"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "ai_customer_result"("tenant_id", "run_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "file"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_customer_result" ADD CONSTRAINT "ai_customer_result_tenant_id_deleted_by_user_id_fkey" FOREIGN KEY ("tenant_id", "deleted_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (AI 2 plan, Task 2): row-level security, checks, the new run kinds and plan switches, and
-- keys checked at commit.

ALTER TABLE ai_customer_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_customer_result FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_customer_result_isolation ON ai_customer_result
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- CUSTOMER_TOOLS in src/modules/ai/customer-tools/customer-tools.ts.
ALTER TABLE ai_customer_result ADD CONSTRAINT ai_customer_result_tool_check
  CHECK (tool IN ('recommendations', 'marketing', 'brand_content', 'image'));
ALTER TABLE ai_customer_result ADD CONSTRAINT ai_customer_result_credits_check CHECK (credits > 0);
ALTER TABLE ai_customer_result ADD CONSTRAINT ai_customer_result_deleted_check
  CHECK ((deleted_at IS NULL) = (deleted_by_user_id IS NULL));

-- RunKind in src/modules/ai/runs.service.ts, and PLAN_FEATURES in src/modules/payments/plans/plans.ts.
ALTER TABLE ai_run DROP CONSTRAINT ai_run_kind_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_kind_check
  CHECK (kind IN ('ask', 'briefing', 'recommendations', 'marketing', 'brand_content', 'image'));
ALTER TABLE plan DROP CONSTRAINT plan_features_check;
ALTER TABLE plan ADD CONSTRAINT plan_features_check
  CHECK (features <@ ARRAY['progress_emails', 'pay_later', 'ai_recommendations', 'ai_marketing', 'ai_brand', 'ai_images']::text[]);

-- Deleting a workspace cascades into its runs, results, spends, files, customers and users in no fixed
-- order. These keys are checked at commit, when the whole cascade is done.
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_run_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_spend_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_parent_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_file_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_customer_result ALTER CONSTRAINT ai_customer_result_tenant_id_deleted_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
