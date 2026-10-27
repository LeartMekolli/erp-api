-- CreateTable
CREATE TABLE "order_payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "provider_checkout_id" TEXT,
    "url" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_payment_tenant_id_order_id_idx" ON "order_payment"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_payment_tenant_id_id_key" ON "order_payment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_payment_tenant_id_provider_checkout_id_key" ON "order_payment"("tenant_id", "provider_checkout_id");

-- AddForeignKey
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment" ADD CONSTRAINT "order_payment_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE order_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY order_payment_isolation ON order_payment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_payment ADD CONSTRAINT order_payment_status_check CHECK (status IN ('open', 'complete', 'expired'));
ALTER TABLE order_payment ADD CONSTRAINT order_payment_amount_check CHECK (amount > 0);

-- One open checkout per order (Payments plan, Review Focus 2), kept by the database too: the service
-- keeps it under the order row lock; this is the backstop. A trigger rather than a partial unique
-- index, as job_assignment_one_open: Prisma would drop an index its schema can't hold.
CREATE OR REPLACE FUNCTION order_payment_one_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'open' THEN
    -- Serialises writers of the same order, as the service's own lock does.
    PERFORM 1 FROM "order" WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM order_payment
      WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id AND id <> NEW.id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'order % already has an open checkout', NEW.order_id
        USING ERRCODE = '23505', HINT = 'Expire the open one first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_payment_one_open
  BEFORE INSERT OR UPDATE OF status ON order_payment
  FOR EACH ROW EXECUTE FUNCTION order_payment_one_open();
