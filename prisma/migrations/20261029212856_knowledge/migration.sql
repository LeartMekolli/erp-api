-- CreateTable
CREATE TABLE "knowledge_article" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_attachment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT (current_setting('app.current_tenant_id'::text))::uuid,
    "article_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "knowledge_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_article_tenant_id_status_idx" ON "knowledge_article"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_article_tenant_id_id_key" ON "knowledge_article"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "knowledge_attachment_tenant_id_file_id_idx" ON "knowledge_attachment"("tenant_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_attachment_tenant_id_article_id_file_id_key" ON "knowledge_attachment"("tenant_id", "article_id", "file_id");

-- AddForeignKey
ALTER TABLE "knowledge_article" ADD CONSTRAINT "knowledge_article_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_article" ADD CONSTRAINT "knowledge_article_tenant_id_created_by_user_id_fkey" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app_user"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_attachment" ADD CONSTRAINT "knowledge_attachment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_attachment" ADD CONSTRAINT "knowledge_attachment_tenant_id_article_id_fkey" FOREIGN KEY ("tenant_id", "article_id") REFERENCES "knowledge_article"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_attachment" ADD CONSTRAINT "knowledge_attachment_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "file"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Tenant-owned (src/database/rls.sql.md).
ALTER TABLE knowledge_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_article FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_article_isolation ON knowledge_article
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE knowledge_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_attachment_isolation ON knowledge_attachment
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE knowledge_article ADD CONSTRAINT knowledge_article_status_check CHECK (status IN ('draft', 'published', 'archived'));
ALTER TABLE knowledge_article ADD CONSTRAINT knowledge_article_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE knowledge_attachment ADD CONSTRAINT knowledge_attachment_position_check CHECK (position >= 0);

-- Deleting a workspace cascades into its articles, attachments, files and users in no fixed order. These
-- keys are checked at commit, when the whole cascade is done.
ALTER TABLE knowledge_article ALTER CONSTRAINT knowledge_article_tenant_id_created_by_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_attachment ALTER CONSTRAINT knowledge_attachment_tenant_id_file_id_fkey DEFERRABLE INITIALLY DEFERRED;
