-- Hand-written. Migrations run as erp_owner, which owns every table, so the
-- application role starts with no privileges at all: Postgres does not grant
-- retroactively.
--
-- Schema usage is granted here rather than only in the Compose init script:
-- `prisma migrate reset` drops and recreates the public schema, which discards
-- any grant made on it outside the migrations.
--
-- The ALTER DEFAULT PRIVILEGES lines apply to objects erp_owner creates from
-- now on, so future migrations need no grant of their own.

GRANT USAGE ON SCHEMA public TO erp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
