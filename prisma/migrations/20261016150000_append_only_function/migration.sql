-- Append-only tables (ADR 0003): rows are evidence, so they are never updated,
-- deleted or truncated. A correction is a new row referencing the one it
-- corrects.
--
-- Usage, in the migration that creates the table:
--
--   SELECT make_append_only('<table>');
--
-- Two layers. erp_app loses UPDATE, DELETE and TRUNCATE, so the application is
-- stopped by privilege before any trigger runs. The trigger stops everyone else
-- who still holds those privileges, the owner included. Getting past it takes a
-- deliberate ALTER TABLE ... DISABLE TRIGGER, which is visible in a migration.
--
-- The trigger is statement-level, so it fires even when no row matches: an
-- attempted mutation is always an error, never a silent no-op.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501', HINT = 'Insert a correcting row instead.';
END;
$$;

-- CREATE OR REPLACE TRIGGER makes a repeated call harmless.
CREATE OR REPLACE FUNCTION make_append_only(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER forbid_mutation
       BEFORE UPDATE OR DELETE OR TRUNCATE ON %s
       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()',
    target
  );
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM erp_app', target);
END;
$$;

-- Schema changes belong to migrations; the application has no reason to call it.
REVOKE EXECUTE ON FUNCTION make_append_only(regclass) FROM PUBLIC;
