-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL,
    "discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "monthly_credits" INTEGER NOT NULL DEFAULT 0,
    "member_limit" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider_product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_price" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "plan_id" UUID NOT NULL,
    "interval" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "provider_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_speed" (
    "plan_id" UUID NOT NULL,
    "delivery_speed_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "surcharge_percent" DECIMAL(9,4),

    CONSTRAINT "plan_speed_pkey" PRIMARY KEY ("plan_id","delivery_speed_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_tenant_id_key_key" ON "plan"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_tenant_id_id_key" ON "plan"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "plan_price_tenant_id_plan_id_idx" ON "plan_price"("tenant_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_price_tenant_id_id_key" ON "plan_price"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_price_tenant_id_provider_price_id_key" ON "plan_price"("tenant_id", "provider_price_id");

-- CreateIndex
CREATE INDEX "plan_speed_tenant_id_idx" ON "plan_speed"("tenant_id");

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_price" ADD CONSTRAINT "plan_price_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_price" ADD CONSTRAINT "plan_price_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "plan"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_speed" ADD CONSTRAINT "plan_speed_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_speed" ADD CONSTRAINT "plan_speed_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "plan"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_speed" ADD CONSTRAINT "plan_speed_tenant_id_delivery_speed_id_fkey" FOREIGN KEY ("tenant_id", "delivery_speed_id") REFERENCES "delivery_speed"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_isolation ON plan
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE plan_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_price FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_price_isolation ON plan_price
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE plan_speed ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_speed FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_speed_isolation ON plan_speed
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The switches are PLAN_FEATURES in src/modules/payments/plans/plans.ts; a new switch widens this check.
ALTER TABLE plan ADD CONSTRAINT plan_status_check CHECK (status IN ('active', 'archived'));
ALTER TABLE plan ADD CONSTRAINT plan_discount_check CHECK (discount_percent >= 0 AND discount_percent <= 100);
ALTER TABLE plan ADD CONSTRAINT plan_credits_check CHECK (monthly_credits >= 0);
ALTER TABLE plan ADD CONSTRAINT plan_member_limit_check CHECK (member_limit IS NULL OR member_limit >= 1);
ALTER TABLE plan ADD CONSTRAINT plan_features_check CHECK (features <@ ARRAY['progress_emails', 'pay_later']::text[]);
ALTER TABLE plan_price ADD CONSTRAINT plan_price_interval_check CHECK ("interval" IN ('month', 'year'));
ALTER TABLE plan_price ADD CONSTRAINT plan_price_amount_check CHECK (amount > 0);
ALTER TABLE plan_speed ADD CONSTRAINT plan_speed_surcharge_check
  CHECK (surcharge_percent IS NULL OR (surcharge_percent >= 0 AND surcharge_percent <= 500));

-- Every existing workspace gets its free default plan, as createDefaultPlan gives a new one, and its
-- owner role the two new permissions.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id, default_currency FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);
    INSERT INTO plan (id, tenant_id, key, name, description, position, is_default, currency, member_limit)
    VALUES (gen_random_uuid(), t.id, 'starter', 'Starter', 'Order at standard prices and speed.', 0, true, t.default_currency, 2)
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('plan.write'), ('credit.grant')) AS p(permission)
    WHERE r.is_system AND r.name = 'owner'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$$;
