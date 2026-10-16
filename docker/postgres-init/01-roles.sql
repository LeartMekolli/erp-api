-- Runs once, on an empty data directory, as the superuser.
--
-- Two roles (ADR 0001). Migrations run as erp_owner, which owns the schema and
-- every table. The application connects as erp_app, which owns nothing and
-- cannot bypass row-level security. Table and schema privileges for erp_app
-- are granted by migrations, so they survive `prisma migrate reset`.

CREATE ROLE erp_owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE erp_app LOGIN PASSWORD 'app_pw';

-- `prisma migrate dev` creates and drops a shadow database to diff migrations.
ALTER ROLE erp_owner CREATEDB;

ALTER DATABASE erp OWNER TO erp_owner;
ALTER SCHEMA public OWNER TO erp_owner;

GRANT CONNECT ON DATABASE erp TO erp_app;
