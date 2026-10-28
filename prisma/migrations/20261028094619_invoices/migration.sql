-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "provider_invoice_id" TEXT,
    "url" TEXT,
    "lines_amount" DECIMAL(18,2) NOT NULL,
    "shipping" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3),
    "overdue_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_id_key" ON "invoice"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_order_id_key" ON "invoice"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_provider_invoice_id_key" ON "invoice"("tenant_id", "provider_invoice_id");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_isolation ON invoice
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE invoice ADD CONSTRAINT invoice_status_check CHECK (status IN ('creating', 'open', 'paid', 'void'));
ALTER TABLE invoice ADD CONSTRAINT invoice_amounts_check
  CHECK (lines_amount >= 0 AND shipping >= 0 AND tax >= 0 AND total > 0 AND total = lines_amount + shipping + tax);
-- Once the provider has made it, an invoice has its id and page there.
ALTER TABLE invoice ADD CONSTRAINT invoice_made_check
  CHECK (status = 'creating' OR (provider_invoice_id IS NOT NULL AND url IS NOT NULL));
ALTER TABLE invoice ADD CONSTRAINT invoice_paid_at_check CHECK ((status = 'paid') = (paid_at IS NOT NULL));
