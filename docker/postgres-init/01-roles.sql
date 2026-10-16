-- Runs once, on an empty data directory, as the superuser.
--
-- Two roles, because row-level security does not apply to a table's owner
-- (ADR 0001). Migrations run as erp_owner and so are unrestricted; the
-- application connects as erp_app and is subject to every policy.

CREATE ROLE erp_owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE erp_app LOGIN PASSWORD 'app_pw';

-- `prisma migrate dev` creates and drops a shadow database to diff migrations.
ALTER ROLE erp_owner CREATEDB;

ALTER DATABASE erp OWNER TO erp_owner;
ALTER SCHEMA public OWNER TO erp_owner;

GRANT CONNECT ON DATABASE erp TO erp_app;
GRANT USAGE ON SCHEMA public TO erp_app;
