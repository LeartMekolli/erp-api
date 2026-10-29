-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "ai_monthly_limit_usd" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "ai_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "user_id" UUID,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run_result" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "run_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL,
    "output" JSONB,
    "refs" JSONB NOT NULL,
    "error" TEXT,
    "finished_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_limit_notice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "month" CHAR(7) NOT NULL,
    "level" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_limit_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_run_tenant_id_created_at_idx" ON "ai_run"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_run_tenant_id_user_id_created_at_idx" ON "ai_run"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_run_tenant_id_id_key" ON "ai_run"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_run_result_run_id_key" ON "ai_run_result"("run_id");

-- CreateIndex
CREATE INDEX "ai_run_result_tenant_id_finished_at_idx" ON "ai_run_result"("tenant_id", "finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_run_result_tenant_id_run_id_key" ON "ai_run_result"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_limit_notice_tenant_id_month_level_key" ON "ai_limit_notice"("tenant_id", "month", "level");

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run_result" ADD CONSTRAINT "ai_run_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run_result" ADD CONSTRAINT "ai_run_result_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "ai_run"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_limit_notice" ADD CONSTRAINT "ai_limit_notice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
