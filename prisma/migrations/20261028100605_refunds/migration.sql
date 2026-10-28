-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "status" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_tenant_id_order_id_idx" ON "refund"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_tenant_id_id_key" ON "refund"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_tenant_id_provider_refund_id_key" ON "refund"("tenant_id", "provider_refund_id");

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Checked at commit, as the ledger's are: deleting a workspace cascades to its users and its refunds
-- in no set order.
ALTER TABLE refund ALTER CONSTRAINT refund_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund FORCE ROW LEVEL SECURITY;
CREATE POLICY refund_isolation ON refund
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE refund ADD CONSTRAINT refund_kind_check CHECK (kind IN ('provider', 'outside'));
ALTER TABLE refund ADD CONSTRAINT refund_status_check CHECK (status IN ('pending', 'succeeded', 'failed'));
ALTER TABLE refund ADD CONSTRAINT refund_amount_check CHECK (amount > 0);
-- Only a refund through the provider has the provider's id.
ALTER TABLE refund ADD CONSTRAINT refund_provider_id_check CHECK (kind = 'provider' OR provider_refund_id IS NULL);
