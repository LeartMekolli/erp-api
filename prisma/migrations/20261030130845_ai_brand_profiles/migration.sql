-- CreateTable
CREATE TABLE "ai_brand_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sells" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_brand_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_brand_profile_tenant_id_customer_id_key" ON "ai_brand_profile"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "ai_brand_profile" ADD CONSTRAINT "ai_brand_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_brand_profile" ADD CONSTRAINT "ai_brand_profile_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_brand_profile" ADD CONSTRAINT "ai_brand_profile_tenant_id_updated_by_user_id_fkey" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (AI 2 plan, Task 3): row-level security, checks and keys checked at commit.

ALTER TABLE ai_brand_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_brand_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_brand_profile_isolation ON ai_brand_profile
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The lengths of brandProfileBodySchema in src/modules/ai/customer-tools/brand-profile-response.ts.
ALTER TABLE ai_brand_profile ADD CONSTRAINT ai_brand_profile_name_check CHECK (char_length(name) BETWEEN 1 AND 100);
ALTER TABLE ai_brand_profile ADD CONSTRAINT ai_brand_profile_sells_check CHECK (char_length(sells) BETWEEN 1 AND 500);
ALTER TABLE ai_brand_profile ADD CONSTRAINT ai_brand_profile_audience_check CHECK (char_length(audience) BETWEEN 1 AND 500);
ALTER TABLE ai_brand_profile ADD CONSTRAINT ai_brand_profile_tone_check CHECK (char_length(tone) BETWEEN 1 AND 200);
ALTER TABLE ai_brand_profile ADD CONSTRAINT ai_brand_profile_notes_check CHECK (char_length(notes) <= 1000);

-- Deleting a workspace cascades into its profiles, customers and users in no fixed order. These keys are
-- checked at commit, when the whole cascade is done.
ALTER TABLE ai_brand_profile ALTER CONSTRAINT ai_brand_profile_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_brand_profile ALTER CONSTRAINT ai_brand_profile_tenant_id_updated_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
