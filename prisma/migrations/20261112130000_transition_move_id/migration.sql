-- Hand-written: every row one request wrote shares a move_id (Move history spec). Rows from before it
-- take their own id, so each old row is an action of one.
--
-- transition is append-only, so the backfill is the one UPDATE it ever gets: the trigger is switched
-- off for it and back on right after, in this same migration.

ALTER TABLE "transition" ADD COLUMN "move_id" UUID;

ALTER TABLE transition DISABLE TRIGGER forbid_mutation;

-- Row security is forced on the owner too, so each workspace is set in turn (see row_level_security).
DO $$
DECLARE
  workspace uuid;
BEGIN
  FOR workspace IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.current_tenant_id', workspace::text, true);
    UPDATE transition SET move_id = id WHERE move_id IS NULL;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END $$;

ALTER TABLE transition ENABLE TRIGGER forbid_mutation;

ALTER TABLE "transition" ALTER COLUMN "move_id" SET NOT NULL;

CREATE INDEX "transition_tenant_id_move_id_idx" ON "transition"("tenant_id", "move_id");
