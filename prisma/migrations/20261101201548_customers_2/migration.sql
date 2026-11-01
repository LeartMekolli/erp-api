-- AlterTable
ALTER TABLE "credit_campaign_target" ADD COLUMN     "customer_group_id" UUID;

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "billing_address" JSONB,
ADD COLUMN     "shipping_address" JSONB,
ADD COLUMN     "vat_number" TEXT;

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "customer_group_id" UUID;

-- AlterTable
ALTER TABLE "work_order_group" ADD COLUMN     "queue_rank" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customer_priority" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "parts" JSONB NOT NULL,
    "band_key" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "override_band_key" TEXT,
    "override_reason" TEXT,
    "override_ends_on" DATE,
    "override_by_user_id" UUID,

    CONSTRAINT "customer_priority_pkey" PRIMARY KEY ("tenant_id","customer_id")
);

-- CreateIndex
CREATE INDEX "customer_priority_tenant_id_band_key_idx" ON "customer_priority"("tenant_id", "band_key");

-- CreateIndex
CREATE INDEX "credit_campaign_target_tenant_id_customer_group_id_idx" ON "credit_campaign_target"("tenant_id", "customer_group_id");

-- CreateIndex
CREATE INDEX "work_order_group_tenant_id_queue_rank_idx" ON "work_order_group"("tenant_id", "queue_rank");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_customer_group_id_fkey" FOREIGN KEY ("tenant_id", "customer_group_id") REFERENCES "customer_group"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_priority" ADD CONSTRAINT "customer_priority_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_priority" ADD CONSTRAINT "customer_priority_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_priority" ADD CONSTRAINT "customer_priority_tenant_id_override_by_user_id_fkey" FOREIGN KEY ("tenant_id", "override_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_campaign_target" ADD CONSTRAINT "credit_campaign_target_tenant_id_customer_group_id_fkey" FOREIGN KEY ("tenant_id", "customer_group_id") REFERENCES "customer_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Customers 2 plan, Task 1): the orders' groups, row-level security, checks, and keys
-- checked at commit.

-- Orders placed before this count under the group their customer is in now (Customers 2 spec, goal 5).
-- Row security is forced on the owner too, so each workspace is set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    UPDATE "order" o SET customer_group_id = c.customer_group_id
    FROM customer c
    WHERE c.id = o.customer_id AND c.customer_group_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

ALTER TABLE customer_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_priority FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_priority_isolation ON customer_priority
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- A VAT number is printed as given: never blank or padded.
ALTER TABLE customer ADD CONSTRAINT customer_vat_number_check
  CHECK (vat_number IS NULL OR (vat_number = btrim(vat_number) AND vat_number <> '' AND length(vat_number) <= 40));
-- A campaign target names exactly one plan, customer or customer group (it was one plan or customer).
ALTER TABLE credit_campaign_target DROP CONSTRAINT credit_campaign_target_one_check;
ALTER TABLE credit_campaign_target ADD CONSTRAINT credit_campaign_target_one_check
  CHECK (num_nonnulls(plan_id, customer_id, customer_group_id) = 1);
ALTER TABLE customer_priority ADD CONSTRAINT customer_priority_score_check CHECK (score BETWEEN 0 AND 100);
-- An override has its band, reason, end date and author, or none of them.
ALTER TABLE customer_priority ADD CONSTRAINT customer_priority_override_check
  CHECK (num_nonnulls(override_band_key, override_reason, override_ends_on, override_by_user_id) IN (0, 4));
ALTER TABLE work_order_group ADD CONSTRAINT work_order_group_queue_rank_check CHECK (queue_rank >= 0);

-- Deleting a workspace cascades into these rows and what they point at in no fixed order. These keys
-- are checked at commit, when the whole cascade is done.
ALTER TABLE "order" ALTER CONSTRAINT order_tenant_id_customer_group_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE customer_priority ALTER CONSTRAINT customer_priority_tenant_id_override_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
