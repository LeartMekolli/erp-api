-- AlterTable
ALTER TABLE "category" ADD COLUMN     "workflow_id" UUID;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "workflow_id" UUID;

-- CreateTable
CREATE TABLE "workflow" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "workflow_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "step_type_id" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "sop_file_version_id" UUID,
    "expected_minutes" DECIMAL(9,2),

    CONSTRAINT "workflow_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_tenant_id_key_key" ON "workflow"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_tenant_id_id_key" ON "workflow"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_tenant_id_workflow_id_number_key" ON "workflow_version"("tenant_id", "workflow_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_tenant_id_id_key" ON "workflow_version"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_version_id_key_key" ON "workflow_step"("version_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_version_id_position_key" ON "workflow_step"("version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_tenant_id_id_key" ON "workflow_step"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflow"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflow"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflow"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_tenant_id_version_id_fkey" FOREIGN KEY ("tenant_id", "version_id") REFERENCES "workflow_version"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_tenant_id_sop_file_version_id_fkey" FOREIGN KEY ("tenant_id", "sop_file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_isolation ON workflow
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE workflow_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_version FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_version_isolation ON workflow_version
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE workflow_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_step_isolation ON workflow_step
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
