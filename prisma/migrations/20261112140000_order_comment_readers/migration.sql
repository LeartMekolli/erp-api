-- Hand-written: where a comment is posted decides who reads it, so `visibility` goes. A comment naming a
-- partner is read by that partner; any other by staff alone. Comments staff wrote for the customer name no
-- partner already, so they become staff only with no change to their rows, as do the customer's own.
ALTER TABLE order_comment
  DROP CONSTRAINT order_comment_partner_iff_partner,
  DROP CONSTRAINT order_comment_visibility_valid,
  DROP CONSTRAINT order_comment_visibility_author,
  DROP CONSTRAINT order_comment_visibility_line;
ALTER TABLE order_comment DROP COLUMN visibility;

-- A partner reads only comments on a line; its own always name it, and the customer's never name one.
ALTER TABLE order_comment
  ADD CONSTRAINT order_comment_partner_line CHECK (partner_id IS NULL OR line_id IS NOT NULL),
  ADD CONSTRAINT order_comment_partner_author CHECK (
    CASE author_kind WHEN 'partner' THEN partner_id IS NOT NULL WHEN 'customer' THEN partner_id IS NULL ELSE true END
  );
