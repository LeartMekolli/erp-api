-- Hand-written: a staff comment for the partner names the partner it was written to, so the next partner
-- on the line never reads it. Earlier ones named none; they become staff only.

-- Row security is forced on the owner too, so each workspace is set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    UPDATE order_comment SET visibility = 'staff' WHERE author_kind = 'staff' AND visibility = 'partner';
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

-- A comment names a partner exactly when it is a partner's: written by it, or by staff to it.
ALTER TABLE order_comment DROP CONSTRAINT order_comment_partner_iff_partner;
ALTER TABLE order_comment
  ADD CONSTRAINT order_comment_partner_iff_partner CHECK ((visibility = 'partner') = (partner_id IS NOT NULL));
