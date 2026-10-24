-- AlterTable
ALTER TABLE "workflow_step" ADD COLUMN     "done_by" TEXT NOT NULL DEFAULT 'partner';

-- AlterTable
ALTER TABLE "workflow_version" ADD COLUMN     "payout_step_id" UUID;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_tenant_id_payout_step_id_fkey" FOREIGN KEY ("tenant_id", "payout_step_id") REFERENCES "workflow_step"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Existing steps become partner steps through the column default, and existing versions keep a null
-- payout step, which means the last partner step: nothing already running changes (Partners spec, B3).

ALTER TABLE workflow_step
  ADD CONSTRAINT workflow_step_done_by_valid CHECK (done_by IN ('partner', 'workspace'));
