/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,id]` on the table `quote` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "work_order_group" ADD COLUMN     "quote_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "quote_tenant_id_id_key" ON "quote"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "work_order_group" ADD CONSTRAINT "work_order_group_tenant_id_quote_id_fkey" FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "quote"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Groups started before this knew their quote only as their source (Orders plan, Task 3). Row-level
-- security is forced even for the table owner, so each tenant is set in turn, as inTenant does.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', t::text, true);
    UPDATE work_order_group SET quote_id = source_id WHERE source_type = 'quote' AND quote_id IS NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;
