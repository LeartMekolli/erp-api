-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "customer_site_origin" TEXT;

-- CreateTable
CREATE TABLE "customer_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "customer_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_invitation_token_hash_key" ON "customer_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "customer_invitation_tenant_id_customer_id_email_idx" ON "customer_invitation"("tenant_id", "customer_id", "email");

-- AddForeignKey
ALTER TABLE "customer_invitation" ADD CONSTRAINT "customer_invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invitation" ADD CONSTRAINT "customer_invitation_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE customer_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invitation FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_invitation_isolation ON customer_invitation
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
