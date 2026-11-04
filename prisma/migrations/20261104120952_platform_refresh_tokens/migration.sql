-- CreateTable
CREATE TABLE "platform_refresh_token" (
    "id" UUID NOT NULL,
    "platform_admin_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "rotated_from_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "platform_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_refresh_token_token_hash_key" ON "platform_refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "platform_refresh_token_family_id_idx" ON "platform_refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "platform_refresh_token_platform_admin_id_idx" ON "platform_refresh_token"("platform_admin_id");

-- AddForeignKey
ALTER TABLE "platform_refresh_token" ADD CONSTRAINT "platform_refresh_token_platform_admin_id_fkey" FOREIGN KEY ("platform_admin_id") REFERENCES "platform_admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
