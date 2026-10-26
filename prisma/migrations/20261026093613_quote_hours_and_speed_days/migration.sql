/*
  Warnings:

  - You are about to drop the column `quote_valid_days` on the `pricing_profile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "delivery_speed" ADD COLUMN     "working_days" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
-- A quote holds for hours, not days (Orders spec, goal 2): existing validities are kept, as hours.
ALTER TABLE "pricing_profile" ADD COLUMN "quote_valid_hours" INTEGER NOT NULL DEFAULT 4;

-- Row-level security is forced even for the table owner, so each tenant is set in turn, as
-- inTenant does (the same loop as the partners migration's permission backfill).
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    UPDATE pricing_profile SET quote_valid_hours = LEAST(quote_valid_days * 24, 720);
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

ALTER TABLE "pricing_profile" DROP COLUMN "quote_valid_days";

ALTER TABLE pricing_profile
  ADD CONSTRAINT pricing_profile_quote_valid_hours_range CHECK (quote_valid_hours BETWEEN 1 AND 720);
ALTER TABLE delivery_speed
  ADD CONSTRAINT delivery_speed_working_days_range CHECK (working_days BETWEEN 0 AND 365);