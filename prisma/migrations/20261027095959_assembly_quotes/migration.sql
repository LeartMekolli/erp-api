-- AlterTable
ALTER TABLE "quote" ADD COLUMN     "parent_quote_id" UUID,
ADD COLUMN     "position" INTEGER;

-- CreateIndex
CREATE INDEX "quote_tenant_id_parent_quote_id_idx" ON "quote"("tenant_id", "parent_quote_id");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_tenant_id_parent_quote_id_fkey" FOREIGN KEY ("tenant_id", "parent_quote_id") REFERENCES "quote"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A part's quote names its assembly's and its position together, never one without the other, and
-- never itself (Orders spec, goal 6).
ALTER TABLE quote
  ADD CONSTRAINT quote_part_position CHECK ((parent_quote_id IS NULL) = (position IS NULL)),
  ADD CONSTRAINT quote_part_position_valid CHECK (position IS NULL OR position >= 0),
  ADD CONSTRAINT quote_part_not_itself CHECK (parent_quote_id IS NULL OR parent_quote_id <> id);
