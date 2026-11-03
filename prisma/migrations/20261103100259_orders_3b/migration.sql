-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "purpose" TEXT NOT NULL,
    "order_id" UUID,
    "claim_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_shipment_id" TEXT,
    "carrier" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "tracking" TEXT,
    "label_url" TEXT,
    "cost" DECIMAL(18,2),
    "currency" TEXT,
    "parcel" JSONB NOT NULL,
    "tracking_status" TEXT,
    "error" TEXT,
    "charged_assignment_id" UUID,
    "owed_reduction" DECIMAL(18,2),
    "shortfall" DECIMAL(18,2),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "provider_event_id" TEXT NOT NULL,
    "tracking" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "courier_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_account" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "provider" TEXT NOT NULL DEFAULT 'easypost',
    "api_key" BYTEA NOT NULL,
    "webhook_secret" BYTEA NOT NULL,
    "from_address" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_account_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "step_capacity" (
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "step_type_id" UUID NOT NULL,
    "daily_pieces" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_capacity_pkey" PRIMARY KEY ("tenant_id","step_type_id")
);

-- CreateTable
CREATE TABLE "job_summary" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "assignment_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "description" TEXT,
    "watch_outs" JSONB,
    "recommendations" JSONB,
    "production_days" INTEGER,
    "used_history" BOOLEAN,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_tenant_id_order_id_idx" ON "shipment"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "shipment_tenant_id_claim_id_idx" ON "shipment"("tenant_id", "claim_id");

-- CreateIndex
CREATE INDEX "shipment_tenant_id_tracking_idx" ON "shipment"("tenant_id", "tracking");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_tenant_id_id_key" ON "shipment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "courier_event_tenant_id_provider_event_id_key" ON "courier_event"("tenant_id", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "courier_event_tenant_id_id_key" ON "courier_event"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_summary_run_id_key" ON "job_summary"("run_id");

-- CreateIndex
CREATE INDEX "job_summary_tenant_id_assignment_id_idx" ON "job_summary"("tenant_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_summary_tenant_id_run_id_key" ON "job_summary"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_summary_tenant_id_id_key" ON "job_summary"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tenant_id_claim_id_fkey" FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "claim"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tenant_id_charged_assignment_id_fkey" FOREIGN KEY ("tenant_id", "charged_assignment_id") REFERENCES "job_assignment"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_event" ADD CONSTRAINT "courier_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_account" ADD CONSTRAINT "courier_account_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_capacity" ADD CONSTRAINT "step_capacity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_capacity" ADD CONSTRAINT "step_capacity_tenant_id_step_type_id_fkey" FOREIGN KEY ("tenant_id", "step_type_id") REFERENCES "step_type"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_summary" ADD CONSTRAINT "job_summary_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_summary" ADD CONSTRAINT "job_summary_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "job_assignment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_summary" ADD CONSTRAINT "job_summary_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "ai_run"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (Orders 3b plan, Task 1): row-level security, checks, one label at a time, one sweep
-- summary per job, and keys checked at commit.
ALTER TABLE shipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment FORCE ROW LEVEL SECURITY;
CREATE POLICY shipment_isolation ON shipment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE courier_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_event FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_event_isolation ON courier_event
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE courier_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_account FORCE ROW LEVEL SECURITY;
CREATE POLICY courier_account_isolation ON courier_account
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE step_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY step_capacity_isolation ON step_capacity
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE job_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_summary FORCE ROW LEVEL SECURITY;
CREATE POLICY job_summary_isolation ON job_summary
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE shipment ADD CONSTRAINT shipment_purpose_check CHECK (purpose IN ('order', 'remake', 'return'));
ALTER TABLE shipment ADD CONSTRAINT shipment_status_check CHECK (status IN ('pending', 'bought', 'failed'));
-- An order's label names the order; a remake's or a return's names the claim, and never both.
ALTER TABLE shipment ADD CONSTRAINT shipment_subject_check CHECK (
  (purpose = 'order' AND order_id IS NOT NULL AND claim_id IS NULL)
  OR (purpose <> 'order' AND claim_id IS NOT NULL AND order_id IS NULL)
);
-- A bought label has its tracking number and link.
ALTER TABLE shipment ADD CONSTRAINT shipment_bought_check CHECK (status <> 'bought' OR (tracking IS NOT NULL AND label_url IS NOT NULL));
ALTER TABLE shipment ADD CONSTRAINT shipment_tracking_status_check CHECK (
  tracking_status IS NULL
  OR tracking_status IN ('pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'failure', 'unknown')
);
-- One label bought, or being bought, per order and per claim's purpose: a second purchase is refused.
-- A trigger rather than a partial unique index, as job_assignment_one_open: Prisma's schema can't hold
-- a partial index, and would drop one it doesn't know of in the next migration it generates.
CREATE OR REPLACE FUNCTION shipment_one_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('pending', 'bought') THEN
    -- Serialises two purchases for the same order or claim.
    IF NEW.order_id IS NOT NULL THEN
      PERFORM 1 FROM "order" WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id FOR UPDATE;
    ELSE
      PERFORM 1 FROM claim WHERE tenant_id = NEW.tenant_id AND id = NEW.claim_id FOR UPDATE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM shipment
      WHERE tenant_id = NEW.tenant_id AND id <> NEW.id AND purpose = NEW.purpose AND status IN ('pending', 'bought')
        AND order_id IS NOT DISTINCT FROM NEW.order_id AND claim_id IS NOT DISTINCT FROM NEW.claim_id
    ) THEN
      RAISE EXCEPTION 'a % label is already bought, or being bought', NEW.purpose
        USING ERRCODE = '23505', HINT = 'Use the label bought, or let the failed purchase be tried again.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shipment_one_open
  BEFORE INSERT OR UPDATE OF status ON shipment
  FOR EACH ROW EXECUTE FUNCTION shipment_one_open();

ALTER TABLE courier_account ADD CONSTRAINT courier_account_provider_check CHECK (provider IN ('easypost'));

ALTER TABLE step_capacity ADD CONSTRAINT step_capacity_daily_pieces_check CHECK (daily_pieces BETWEEN 1 AND 100000);

ALTER TABLE job_summary ADD CONSTRAINT job_summary_production_days_check CHECK (production_days IS NULL OR production_days BETWEEN 1 AND 90);
-- The sweep writes one summary per job; staff may ask for more. A trigger, as shipment_one_open.
CREATE OR REPLACE FUNCTION job_summary_one_swept() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requested_by_user_id IS NULL THEN
    PERFORM 1 FROM job_assignment WHERE tenant_id = NEW.tenant_id AND id = NEW.assignment_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM job_summary
      WHERE tenant_id = NEW.tenant_id AND assignment_id = NEW.assignment_id AND id <> NEW.id AND requested_by_user_id IS NULL
    ) THEN
      RAISE EXCEPTION 'job assignment % already has its summary', NEW.assignment_id USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_summary_one_swept
  BEFORE INSERT ON job_summary
  FOR EACH ROW EXECUTE FUNCTION job_summary_one_swept();

-- Deleting a workspace cascades into these rows and what they point at in no fixed order. These keys
-- are checked at commit, when the whole cascade is done.
ALTER TABLE job_summary ALTER CONSTRAINT job_summary_tenant_id_run_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE shipment ALTER CONSTRAINT shipment_tenant_id_charged_assignment_id_fkey DEFERRABLE INITIALLY DEFERRED;
