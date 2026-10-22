-- CreateTable
CREATE TABLE "quote" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "inputs" JSONB NOT NULL,
    "materials" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_tenant_id_idx" ON "quote"("tenant_id");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote FORCE ROW LEVEL SECURITY;

CREATE POLICY quote_isolation ON quote
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
