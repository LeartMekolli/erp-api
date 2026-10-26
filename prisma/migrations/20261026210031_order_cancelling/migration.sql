-- AlterTable
ALTER TABLE "order" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "courier" TEXT,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "shipped_at" TIMESTAMP(3),
ADD COLUMN     "tracking" TEXT;

-- The rules the service keeps, kept by the database too (Orders spec, goals 9 and 12).
ALTER TABLE "order"
  ADD CONSTRAINT order_delivered_after_shipped CHECK (delivered_at IS NULL OR shipped_at IS NOT NULL),
  ADD CONSTRAINT order_cancel_reason CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL));

-- A job whose order line was cancelled: owed what staff set, else nothing. Not open, so the
-- job_assignment_one_open trigger needs no change.
ALTER TABLE job_assignment DROP CONSTRAINT job_assignment_status_valid;
ALTER TABLE job_assignment ADD CONSTRAINT job_assignment_status_valid
  CHECK (status IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn', 'replaced', 'cancelled'));
