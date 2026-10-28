-- CreateTable
CREATE TABLE "credit_pack" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valid_days" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_pack_purchase" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "pack_id" UUID NOT NULL,
    "credits" INTEGER NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valid_days" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "provider_checkout_id" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_pack_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_pack_tenant_id_idx" ON "credit_pack"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_tenant_id_id_key" ON "credit_pack"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "credit_pack_purchase_tenant_id_customer_id_idx" ON "credit_pack_purchase"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_tenant_id_id_key" ON "credit_pack_purchase"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_tenant_id_provider_checkout_id_key" ON "credit_pack_purchase"("tenant_id", "provider_checkout_id");

-- AddForeignKey
ALTER TABLE "credit_pack" ADD CONSTRAINT "credit_pack_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_tenant_id_pack_id_fkey" FOREIGN KEY ("tenant_id", "pack_id") REFERENCES "credit_pack"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE credit_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_pack FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_pack_isolation ON credit_pack
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE credit_pack_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_pack_purchase FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_pack_purchase_isolation ON credit_pack_purchase
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Whole credits, a price and days above zero, and the states (src/modules/payments/credits/credit-response.ts).
ALTER TABLE credit_pack ADD CONSTRAINT credit_pack_values_check
  CHECK (credits > 0 AND price > 0 AND valid_days > 0 AND position >= 0);
ALTER TABLE credit_pack ADD CONSTRAINT credit_pack_status_check CHECK (status IN ('active', 'archived'));
ALTER TABLE credit_pack_purchase ADD CONSTRAINT credit_pack_purchase_values_check
  CHECK (credits > 0 AND price > 0 AND valid_days > 0);
ALTER TABLE credit_pack_purchase ADD CONSTRAINT credit_pack_purchase_status_check CHECK (status IN ('open', 'paid', 'expired'));
-- A paid purchase knows when.
ALTER TABLE credit_pack_purchase ADD CONSTRAINT credit_pack_purchase_paid_check CHECK ((status = 'paid') = (paid_at IS NOT NULL));

-- Deleting a workspace cascades into purchases and the customers, packs and users they point at, in no
-- fixed order. These keys are checked at commit, when the whole cascade is done; deleting one of those
-- alone, while a purchase points at it, still fails at commit.
ALTER TABLE credit_pack_purchase ALTER CONSTRAINT credit_pack_purchase_tenant_id_customer_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_pack_purchase ALTER CONSTRAINT credit_pack_purchase_tenant_id_pack_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_pack_purchase ALTER CONSTRAINT credit_pack_purchase_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
