-- CreateTable
CREATE TABLE "partner_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "partner_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_invitation_token_hash_key" ON "partner_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "partner_invitation_tenant_id_partner_id_email_idx" ON "partner_invitation"("tenant_id", "partner_id", "email");

-- AddForeignKey
ALTER TABLE "partner_invitation" ADD CONSTRAINT "partner_invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_invitation" ADD CONSTRAINT "partner_invitation_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security (src/database/rls.sql.md).

ALTER TABLE partner_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_invitation FORCE ROW LEVEL SECURITY;

CREATE POLICY partner_invitation_isolation ON partner_invitation
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Partner roles, as PARTNER_ROLES.
ALTER TABLE partner_invitation
  ADD CONSTRAINT partner_invitation_role_valid CHECK (role IN ('member', 'admin', 'owner'));
