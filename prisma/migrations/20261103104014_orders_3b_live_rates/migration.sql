-- AlterTable
ALTER TABLE "shipping_method" ADD COLUMN     "default_parcel" JSONB,
ADD COLUMN     "live_carrier" TEXT,
ADD COLUMN     "live_service" TEXT,
ALTER COLUMN "price" DROP NOT NULL;

-- Hand-written (Orders 3b plan, Task 3): a method has a fixed price or is priced live by one courier
-- service it names, never both; a live one has the parcel its rate is asked for.
ALTER TABLE shipping_method ADD CONSTRAINT shipping_method_live_check CHECK (
  (live_carrier IS NULL) = (live_service IS NULL)
  AND (live_service IS NULL) = (price IS NOT NULL)
  AND (live_service IS NULL OR default_parcel IS NOT NULL)
);
ALTER TABLE shipping_method ADD CONSTRAINT shipping_method_live_names_check CHECK (
  (live_carrier IS NULL OR (btrim(live_carrier) <> '' AND length(live_carrier) <= 100))
  AND (live_service IS NULL OR (btrim(live_service) <> '' AND length(live_service) <= 100))
);
