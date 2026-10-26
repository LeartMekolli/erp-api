-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "channel_order_id" TEXT,
    "delivery_speed_key" TEXT,
    "promised_on" DATE NOT NULL,
    "address" JSONB NOT NULL,
    "shipping_method_id" UUID NOT NULL,
    "shipping_price" DECIMAL(18,2) NOT NULL,
    "lines_total" DECIMAL(18,2) NOT NULL,
    "tax_percent" DECIMAL(9,4) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "note" TEXT,
    "placed_by_user_id" UUID NOT NULL,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "quote_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "group_id" UUID,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_counter" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "order_counter_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "order_tenant_id_customer_id_idx" ON "order"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_tenant_id_number_key" ON "order"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "order_tenant_id_channel_channel_order_id_key" ON "order"("tenant_id", "channel", "channel_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_tenant_id_id_key" ON "order"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_tenant_id_quote_id_key" ON "order_line"("tenant_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_tenant_id_group_id_key" ON "order_line"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_order_id_position_key" ON "order_line"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_tenant_id_id_key" ON "order_line"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenant_id_shipping_method_id_fkey" FOREIGN KEY ("tenant_id", "shipping_method_id") REFERENCES "shipping_method"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_tenant_id_quote_id_fkey" FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quote"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_counter" ADD CONSTRAINT "order_counter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same rules the API applies (Orders spec, goals 1, 11, 15, 17).
ALTER TABLE "order"
  ADD CONSTRAINT order_channel_valid CHECK (channel IN ('staff', 'portal')),
  ADD CONSTRAINT order_number_from_1001 CHECK (number >= 1001),
  ADD CONSTRAINT order_amounts_not_negative CHECK (
    shipping_price >= 0 AND lines_total >= 0 AND tax_amount >= 0 AND total >= 0
  ),
  ADD CONSTRAINT order_tax_percent_range CHECK (tax_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT order_total_adds_up CHECK (total = lines_total + shipping_price + tax_amount),
  ADD CONSTRAINT order_note_length CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000);
ALTER TABLE order_line
  ADD CONSTRAINT order_line_position_valid CHECK (position >= 0),
  ADD CONSTRAINT order_line_quantity_positive CHECK (quantity >= 1),
  ADD CONSTRAINT order_line_amounts_not_negative CHECK (unit_price >= 0 AND total >= 0);
ALTER TABLE order_counter
  ADD CONSTRAINT order_counter_from_1001 CHECK (last_number >= 1001);

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_isolation ON "order"
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_isolation ON order_line
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY order_counter_isolation ON order_counter
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Grants the order permissions to the system roles of existing tenants (SYSTEM_ROLES). Row-level
-- security is forced even for the table owner, so each tenant is set in turn, as inTenant does.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('order.read'), ('order.write')) AS p(permission)
    WHERE r.is_system AND r.name IN ('owner', 'member')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'order.ship'
    FROM role r
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
