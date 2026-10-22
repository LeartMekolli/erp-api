-- CreateTable
CREATE TABLE "metal_price_snapshot" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "metal" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "price_per_gram" DECIMAL(18,9) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metal_price_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metal_price_snapshot_metal_currency_fetched_at_idx" ON "metal_price_snapshot"("metal", "currency", "fetched_at" DESC);
