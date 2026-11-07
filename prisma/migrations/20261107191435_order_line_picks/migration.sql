-- AlterTable
ALTER TABLE "order_line" ADD COLUMN     "picks" JSONB NOT NULL DEFAULT '{"options":[],"size":null,"design_file":null}';

-- AlterTable
ALTER TABLE "order_line_part" ADD COLUMN     "picks" JSONB NOT NULL DEFAULT '{"options":[],"size":null,"design_file":null}';
