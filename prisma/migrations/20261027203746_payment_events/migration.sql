-- CreateTable
CREATE TABLE "payment_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "provider_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "connected_account_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "payment_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_event_tenant_id_provider_event_id_key" ON "payment_event"("tenant_id", "provider_event_id");

-- AddForeignKey
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE payment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_event_isolation ON payment_event
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- The two webhook endpoints of a workspace (src/modules/payments/webhooks.controller.ts).
ALTER TABLE payment_event ADD CONSTRAINT payment_event_endpoint_check CHECK (endpoint IN ('payments', 'connect'));
