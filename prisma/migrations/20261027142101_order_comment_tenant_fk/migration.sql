-- AddForeignKey
ALTER TABLE "order_comment" ADD CONSTRAINT "order_comment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
