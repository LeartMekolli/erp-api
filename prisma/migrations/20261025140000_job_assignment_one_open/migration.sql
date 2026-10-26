-- One open offer or assignment per job (Partners plan, Review Focus 3), kept by the database too. The
-- service already keeps it under the group row lock; this is the backstop for any writer that forgets.
-- A trigger rather than a partial unique index: Prisma's schema can't hold a partial index, and would
-- drop one it doesn't know of in the next migration it generates.

CREATE OR REPLACE FUNCTION job_assignment_one_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('offered', 'accepted') THEN
    -- Serialises writers of the same job, as the service's own lock does.
    PERFORM 1 FROM work_order_group WHERE tenant_id = NEW.tenant_id AND id = NEW.group_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM job_assignment
      WHERE tenant_id = NEW.tenant_id AND group_id = NEW.group_id AND id <> NEW.id AND status IN ('offered', 'accepted')
    ) THEN
      RAISE EXCEPTION 'job % already has an open offer or assignment', NEW.group_id
        USING ERRCODE = '23505', HINT = 'Expire, withdraw or replace the open one first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_assignment_one_open
  BEFORE INSERT OR UPDATE OF status ON job_assignment
  FOR EACH ROW EXECUTE FUNCTION job_assignment_one_open();
