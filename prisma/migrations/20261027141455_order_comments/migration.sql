-- CreateTable
CREATE TABLE "order_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "order_id" UUID NOT NULL,
    "line_id" UUID,
    "author_user_id" UUID NOT NULL,
    "author_kind" TEXT NOT NULL,
    "partner_id" UUID,
    "for_partner" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_comment_attachment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "comment_id" UUID NOT NULL,
    "file_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "order_comment_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_comment_tenant_id_order_id_id_idx" ON "order_comment"("tenant_id", "order_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_comment_tenant_id_id_key" ON "order_comment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "order_comment_attachment_tenant_id_file_version_id_idx" ON "order_comment_attachment"("tenant_id", "file_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_comment_attachment_comment_id_position_key" ON "order_comment_attachment"("comment_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "order_comment_attachment_comment_id_file_version_id_key" ON "order_comment_attachment"("comment_id", "file_version_id");

-- AddForeignKey
ALTER TABLE "order_comment" ADD CONSTRAINT "order_comment_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_comment" ADD CONSTRAINT "order_comment_tenant_id_author_user_id_fkey" FOREIGN KEY ("tenant_id", "author_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_comment" ADD CONSTRAINT "order_comment_tenant_id_partner_id_fkey" FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partner"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_comment_attachment" ADD CONSTRAINT "order_comment_attachment_tenant_id_comment_id_fkey" FOREIGN KEY ("tenant_id", "comment_id") REFERENCES "order_comment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_comment_attachment" ADD CONSTRAINT "order_comment_attachment_tenant_id_file_version_id_fkey" FOREIGN KEY ("tenant_id", "file_version_id") REFERENCES "file_version"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE order_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_comment FORCE ROW LEVEL SECURITY;

CREATE POLICY order_comment_isolation ON order_comment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_comment
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

ALTER TABLE order_comment_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_comment_attachment FORCE ROW LEVEL SECURITY;

CREATE POLICY order_comment_attachment_isolation ON order_comment_attachment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE order_comment_attachment
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.current_tenant_id'::text))::uuid;

-- The rules the service keeps, kept by the database too (Orders spec, goal 13): a partner author
-- names its partner and nobody else does; only staff write for a partner, and only on a line; the
-- text is 1 to 5000 characters; a comment has at most 10 attachments, counted from 0.
ALTER TABLE order_comment
  ADD CONSTRAINT order_comment_author_kind_valid CHECK (author_kind IN ('staff', 'customer', 'partner')),
  ADD CONSTRAINT order_comment_partner_iff_partner CHECK ((author_kind = 'partner') = (partner_id IS NOT NULL)),
  ADD CONSTRAINT order_comment_for_partner_valid CHECK (NOT for_partner OR (author_kind = 'staff' AND line_id IS NOT NULL)),
  ADD CONSTRAINT order_comment_body_valid CHECK (char_length(body) BETWEEN 1 AND 5000);

ALTER TABLE order_comment_attachment
  ADD CONSTRAINT order_comment_attachment_position_valid CHECK (position BETWEEN 0 AND 9);
