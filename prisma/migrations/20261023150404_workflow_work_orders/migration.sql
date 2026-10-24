-- CreateTable
CREATE TABLE "work_order_group" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "workflow_version_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "product_id" UUID,
    "file_version_id" UUID,
    "customer_id" UUID,
    "quantity" INTEGER NOT NULL,
    "chain_step_type_ids" JSONB,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "group_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_step_id" UUID,
    "replaces_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_order_group_tenant_id_source_type_source_id_key" ON "work_order_group"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_group_tenant_id_id_key" ON "work_order_group"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "work_order_tenant_id_replaces_id_idx" ON "work_order"("tenant_id", "replaces_id");

-- CreateIndex
CREATE INDEX "work_order_tenant_id_current_step_id_idx" ON "work_order"("tenant_id", "current_step_id");

-- CreateIndex
CREATE INDEX "work_order_group_id_number_idx" ON "work_order"("group_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_tenant_id_id_key" ON "work_order"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_workflow_version_id_fkey" FOREIGN KEY ("tenant_id", "workflow_version_id") REFERENCES "workflow_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "product"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_tenant_id_current_step_id_fkey" FOREIGN KEY ("tenant_id", "current_step_id") REFERENCES "workflow_step"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_tenant_id_replaces_id_fkey" FOREIGN KEY ("tenant_id", "replaces_id") REFERENCES "work_order"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE work_order
  ADD CONSTRAINT work_order_status_valid CHECK (status IN ('active', 'finished', 'scrapped', 'cancelled')),
  ADD CONSTRAINT work_order_step_while_active CHECK ((status = 'active') = (current_step_id IS NOT NULL));

ALTER TABLE work_order_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_group FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_group_isolation ON work_order_group
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE work_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_isolation ON work_order
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
