/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,schedule_key]` on the table `report_export` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "report_export" ADD COLUMN     "schedule_key" TEXT,
ALTER COLUMN "requested_by_user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "claim" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opened_by_kind" TEXT NOT NULL,
    "return_requested_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "claim_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "pieces" INTEGER NOT NULL,
    "fault" TEXT,
    "outcome" TEXT,
    "note" TEXT,
    "customer_reason" TEXT,
    "refund_amount" DECIMAL(18,2),
    "partner_id" UUID,
    "remake_group_id" UUID,
    "owed_reduction" DECIMAL(18,2),
    "shortfall" DECIMAL(18,2),
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "claim_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_photo" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "claim_id" UUID NOT NULL,
    "file_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "claim_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_shipment" (
    "claim_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "courier" TEXT,
    "tracking" TEXT,
    "shipped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "claim_shipment_pkey" PRIMARY KEY ("claim_id")
);

-- CreateTable
CREATE TABLE "credit_note" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "claim_line_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "provider_credit_note_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_tenant_id_order_id_idx" ON "claim"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_tenant_id_number_key" ON "claim"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "claim_tenant_id_id_key" ON "claim"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "claim_line_tenant_id_order_line_id_idx" ON "claim_line"("tenant_id", "order_line_id");

-- CreateIndex
CREATE INDEX "claim_line_tenant_id_partner_id_decided_at_idx" ON "claim_line"("tenant_id", "partner_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "claim_line_claim_id_order_line_id_key" ON "claim_line"("claim_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_line_tenant_id_id_key" ON "claim_line"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_line_tenant_id_remake_group_id_key" ON "claim_line"("tenant_id", "remake_group_id");

-- CreateIndex
CREATE INDEX "claim_photo_tenant_id_file_version_id_idx" ON "claim_photo"("tenant_id", "file_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_photo_claim_id_position_key" ON "claim_photo"("claim_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "claim_photo_claim_id_file_version_id_key" ON "claim_photo"("claim_id", "file_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_shipment_tenant_id_claim_id_key" ON "claim_shipment"("tenant_id", "claim_id");

-- CreateIndex
CREATE INDEX "credit_note_tenant_id_invoice_id_idx" ON "credit_note"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "credit_note_tenant_id_claim_line_id_idx" ON "credit_note"("tenant_id", "claim_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_tenant_id_id_key" ON "credit_note"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_tenant_id_provider_credit_note_id_key" ON "credit_note"("tenant_id", "provider_credit_note_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_export_tenant_id_schedule_key_key" ON "report_export"("tenant_id", "schedule_key");

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_tenant_id_opened_by_user_id_fkey" FOREIGN KEY ("tenant_id", "opened_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line" ADD CONSTRAINT "claim_line_tenant_id_claim_id_fkey" FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "claim"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line" ADD CONSTRAINT "claim_line_tenant_id_order_line_id_fkey" FOREIGN KEY ("tenant_id", "order_line_id") REFERENCES "order_line"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line" ADD CONSTRAINT "claim_line_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line" ADD CONSTRAINT "claim_line_tenant_id_remake_group_id_fkey" FOREIGN KEY ("tenant_id", "remake_group_id") REFERENCES "work_order_group"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line" ADD CONSTRAINT "claim_line_tenant_id_decided_by_user_id_fkey" FOREIGN KEY ("tenant_id", "decided_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_photo" ADD CONSTRAINT "claim_photo_tenant_id_claim_id_fkey" FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "claim"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_photo" ADD CONSTRAINT "claim_photo_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_shipment" ADD CONSTRAINT "claim_shipment_tenant_id_claim_id_fkey" FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "claim"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoice"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_tenant_id_claim_line_id_fkey" FOREIGN KEY ("tenant_id", "claim_line_id") REFERENCES "claim_line"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Hand-written (Orders 3a plan, Task 1): row-level security, checks, keys checked at commit, the wider
-- journal and export kinds, and the Accountant role for every existing workspace.

ALTER TABLE claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_isolation ON claim
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE claim_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_line FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_line_isolation ON claim_line
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE claim_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_photo_isolation ON claim_photo
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE claim_shipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_shipment FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_shipment_isolation ON claim_shipment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_note_isolation ON credit_note
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE claim ADD CONSTRAINT claim_number_check CHECK (number >= 1);
ALTER TABLE claim ADD CONSTRAINT claim_opened_by_kind_check CHECK (opened_by_kind IN ('staff', 'customer'));
ALTER TABLE claim ADD CONSTRAINT claim_description_check CHECK (btrim(description) <> '' AND length(description) <= 5000);
-- Pieces are received only after they were asked for.
ALTER TABLE claim ADD CONSTRAINT claim_returned_check CHECK (returned_at IS NULL OR return_requested_at IS NOT NULL);

ALTER TABLE claim_line ADD CONSTRAINT claim_line_pieces_check CHECK (pieces >= 1);
ALTER TABLE claim_line ADD CONSTRAINT claim_line_fault_check
  CHECK (fault IS NULL OR fault IN ('workshop', 'workspace', 'courier', 'customer'));
ALTER TABLE claim_line ADD CONSTRAINT claim_line_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('remake', 'refund', 'refuse'));
-- A decision is whole: its fault, outcome, author and time, or none of them.
ALTER TABLE claim_line ADD CONSTRAINT claim_line_decided_check
  CHECK (num_nonnulls(fault, outcome, decided_by_user_id, decided_at) IN (0, 4));
-- The workshop at fault is named exactly when the fault is the workshop's.
ALTER TABLE claim_line ADD CONSTRAINT claim_line_partner_check CHECK ((fault = 'workshop') = (partner_id IS NOT NULL));
ALTER TABLE claim_line ADD CONSTRAINT claim_line_refund_check
  CHECK ((outcome = 'refund') = (refund_amount IS NOT NULL) AND (refund_amount IS NULL OR refund_amount > 0));
ALTER TABLE claim_line ADD CONSTRAINT claim_line_refuse_check
  CHECK (outcome IS DISTINCT FROM 'refuse' OR (customer_reason IS NOT NULL AND btrim(customer_reason) <> ''));
ALTER TABLE claim_line ADD CONSTRAINT claim_line_remake_check CHECK (remake_group_id IS NULL OR outcome = 'remake');
-- What the workshop at fault is owed less, or was paid too much, only for a line at its fault.
ALTER TABLE claim_line ADD CONSTRAINT claim_line_owed_check
  CHECK ((owed_reduction IS NULL OR (owed_reduction >= 0 AND fault = 'workshop'))
     AND (shortfall IS NULL OR (shortfall >= 0 AND fault = 'workshop')));

-- At most 10 photos a claim, as attachments on a comment.
ALTER TABLE claim_photo ADD CONSTRAINT claim_photo_position_check CHECK (position BETWEEN 0 AND 9);

ALTER TABLE claim_shipment ADD CONSTRAINT claim_shipment_delivered_check CHECK (delivered_at IS NULL OR delivered_at >= shipped_at);

ALTER TABLE credit_note ADD CONSTRAINT credit_note_amount_check CHECK (amount > 0);
ALTER TABLE credit_note ADD CONSTRAINT credit_note_status_check CHECK (status IN ('pending', 'issued', 'failed'));
ALTER TABLE credit_note ADD CONSTRAINT credit_note_issued_check
  CHECK (status <> 'issued' OR provider_credit_note_id IS NOT NULL);

-- A scheduled export has no requester and its schedule key; an asked one, its requester.
ALTER TABLE report_export ADD CONSTRAINT report_export_requester_check
  CHECK (num_nonnulls(requested_by_user_id, schedule_key) = 1);
-- EXPORT_KINDS in src/modules/reporting/exports/export-kinds.ts, with top customers (Orders 3 spec, goal 9).
ALTER TABLE report_export DROP CONSTRAINT report_export_kind_check;
ALTER TABLE report_export ADD CONSTRAINT report_export_kind_check
  CHECK (kind IN ('customers', 'orders', 'partners', 'accounting_invoices', 'accounting_payments', 'accounting_refunds',
                  'accounting_payouts', 'dashboard_pdf', 'top_customers'));

-- The ledger's journal kinds (src/modules/payments/ledger.ts), with credit notes on open invoices.
ALTER TABLE ledger_journal DROP CONSTRAINT ledger_journal_kind_check;
ALTER TABLE ledger_journal ADD CONSTRAINT ledger_journal_kind_check
  CHECK (kind IN (
    'order_billed', 'payment_received', 'provider_fee', 'refund', 'payout', 'reversal', 'plan_billed', 'pack_billed',
    'plan_credited', 'credit_applied', 'credit_note'
  ));

-- Deleting a workspace cascades into these rows and what they point at in no fixed order. These keys
-- are checked at commit, when the whole cascade is done.
ALTER TABLE claim ALTER CONSTRAINT claim_tenant_id_opened_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claim_line ALTER CONSTRAINT claim_line_tenant_id_order_line_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claim_line ALTER CONSTRAINT claim_line_tenant_id_partner_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claim_line ALTER CONSTRAINT claim_line_tenant_id_remake_group_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claim_line ALTER CONSTRAINT claim_line_tenant_id_decided_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claim_photo ALTER CONSTRAINT claim_photo_tenant_id_file_version_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_note ALTER CONSTRAINT credit_note_tenant_id_invoice_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE credit_note ALTER CONSTRAINT credit_note_tenant_id_claim_line_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Every existing workspace gets the Accountant system role, which only reads (Orders 3 spec, goal 8); new
-- workspaces get it from SYSTEM_ROLES. Row security is forced on the owner too, so each workspace is set
-- in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    INSERT INTO role (id, tenant_id, name, is_system)
    VALUES (gen_random_uuid(), workspace, 'accountant', true)
    ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO role_permission (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, p.permission
    FROM role r
    CROSS JOIN (VALUES ('payment.read'), ('report.read'), ('report.export')) AS p(permission)
    WHERE r.is_system AND r.name = 'accountant'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;
