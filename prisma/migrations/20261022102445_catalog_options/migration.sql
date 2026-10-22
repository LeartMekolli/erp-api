-- CreateTable
CREATE TABLE "option_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_value" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "group_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "material_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "kind" TEXT NOT NULL,
    "value_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_rule_target" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "rule_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "option_rule_target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "option_group_tenant_id_key_key" ON "option_group"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "option_group_tenant_id_id_key" ON "option_group"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "option_value_group_id_key_key" ON "option_value"("group_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "option_value_tenant_id_id_key" ON "option_value"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "option_rule_tenant_id_value_id_idx" ON "option_rule"("tenant_id", "value_id");

-- CreateIndex
CREATE UNIQUE INDEX "option_rule_tenant_id_id_key" ON "option_rule"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "option_rule_target_tenant_id_idx" ON "option_rule_target"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "option_rule_target_rule_id_value_id_key" ON "option_rule_target"("rule_id", "value_id");

-- AddForeignKey
ALTER TABLE "option_group" ADD CONSTRAINT "option_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_value" ADD CONSTRAINT "option_value_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_value" ADD CONSTRAINT "option_value_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "option_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_value" ADD CONSTRAINT "option_value_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "material"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_rule" ADD CONSTRAINT "option_rule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_rule" ADD CONSTRAINT "option_rule_tenant_id_value_id_fkey" FOREIGN KEY ("tenant_id", "value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_rule_target" ADD CONSTRAINT "option_rule_target_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_rule_target" ADD CONSTRAINT "option_rule_target_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "option_rule"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_rule_target" ADD CONSTRAINT "option_rule_target_tenant_id_value_id_fkey" FOREIGN KEY ("tenant_id", "value_id") REFERENCES "option_value"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).
ALTER TABLE option_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_group FORCE ROW LEVEL SECURITY;

CREATE POLICY option_group_isolation ON option_group
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE option_group
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE option_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_value FORCE ROW LEVEL SECURITY;

CREATE POLICY option_value_isolation ON option_value
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE option_value
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE option_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_rule FORCE ROW LEVEL SECURITY;

CREATE POLICY option_rule_isolation ON option_rule
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE option_rule
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE option_rule_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_rule_target FORCE ROW LEVEL SECURITY;

CREATE POLICY option_rule_target_isolation ON option_rule_target
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE option_rule_target
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

