-- Hand-written: who reads a comment besides staff, in place of for_partner.
ALTER TABLE "order_comment" ADD COLUMN "visibility" TEXT;

-- Row security is forced on the owner too, so each workspace is set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    UPDATE order_comment SET visibility = CASE WHEN for_partner OR author_kind = 'partner' THEN 'partner' ELSE 'customer' END;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

ALTER TABLE order_comment ALTER COLUMN visibility SET NOT NULL;
ALTER TABLE order_comment DROP CONSTRAINT order_comment_for_partner_valid;
ALTER TABLE order_comment DROP COLUMN for_partner;
ALTER TABLE order_comment
  ADD CONSTRAINT order_comment_visibility_valid CHECK (visibility IN ('customer', 'partner', 'staff')),
  ADD CONSTRAINT order_comment_visibility_author CHECK (author_kind = 'staff' OR visibility = author_kind),
  ADD CONSTRAINT order_comment_visibility_line CHECK (visibility <> 'partner' OR line_id IS NOT NULL);
