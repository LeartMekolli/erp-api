-- AlterTable
-- Orders placed before payments existed are pay later: the default fills them, then is dropped below.
ALTER TABLE "order" ADD COLUMN     "held_for_credit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pay_by" TIMESTAMP(3),
ADD COLUMN     "payment_terms" TEXT NOT NULL DEFAULT 'pay_later',
ADD COLUMN     "production_started_at" TIMESTAMP(3),
ADD COLUMN     "release_reason" TEXT,
ADD COLUMN     "released_by_user_id" UUID;

-- CreateTable
CREATE TABLE "customer_payment_terms" (
    "customer_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "terms" TEXT NOT NULL,
    "days_to_pay" INTEGER NOT NULL DEFAULT 30,
    "credit_limit" DECIMAL(18,2),
    "provider_customer_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payment_terms_pkey" PRIMARY KEY ("customer_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_payment_terms_tenant_id_customer_id_key" ON "customer_payment_terms"("tenant_id", "customer_id");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_released_by_user_id_fkey" FOREIGN KEY ("tenant_id", "released_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_terms" ADD CONSTRAINT "customer_payment_terms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_terms" ADD CONSTRAINT "customer_payment_terms_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every order is placed with its terms from now on (orders.service.ts), so the column has no default.
ALTER TABLE "order" ALTER COLUMN "payment_terms" DROP DEFAULT;

-- Orders placed before payments existed started at once. Row-level security is forced even for the
-- table owner, so each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    UPDATE "order" SET production_started_at = placed_at WHERE production_started_at IS NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;

-- Deleting a workspace cascades into its users and its orders in no fixed order, so the order's
-- releaser is checked at commit, as the file's uploader is.
ALTER TABLE "order" ALTER CONSTRAINT "order_tenant_id_released_by_user_id_fkey" DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "order" ADD CONSTRAINT order_payment_terms_check CHECK (payment_terms IN ('pay_first', 'pay_later'));
-- A release names who let the order start, and why.
ALTER TABLE "order" ADD CONSTRAINT order_release_check
  CHECK ((released_by_user_id IS NULL) = (release_reason IS NULL));

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE customer_payment_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payment_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_payment_terms_isolation ON customer_payment_terms
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE customer_payment_terms ADD CONSTRAINT customer_payment_terms_terms_check
  CHECK (terms IN ('pay_first', 'pay_later'));
ALTER TABLE customer_payment_terms ADD CONSTRAINT customer_payment_terms_days_to_pay_check
  CHECK (days_to_pay BETWEEN 1 AND 120);
ALTER TABLE customer_payment_terms ADD CONSTRAINT customer_payment_terms_credit_limit_check
  CHECK (credit_limit IS NULL OR credit_limit >= 0);
