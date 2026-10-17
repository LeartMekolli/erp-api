# ERP API

API for an industry-agnostic, made-to-order production ERP: configurable products, step-based pricing, routing work to production partners, and a configurable production workflow with quality control. Industry specifics are configuration, not code.

## Requirements

- Node.js 24
- Docker, for Postgres 16 and Redis 7

## Running locally

```bash
cp .env.example .env
docker compose up -d
npm ci
npx prisma generate
npx prisma migrate deploy
npm run seed
npm run start:dev
```

The API listens on http://localhost:3000. `GET /health/ready` reports whether Postgres and Redis are reachable.

The seed creates a platform admin (`admin@example.test`, password printed once) and two tenants, `demo` and `sandbox`, each with an owner invitation whose token is printed. It is safe to run again. To create another tenant:

```bash
npm run tenant:create -- --name="Acme Print" --slug=acme-print --owner-email=owner@acme.example [--currency=EUR] [--locale=en] [--timezone=UTC]
```

## Authentication

- **Platform admins** act across tenants (create, list, suspend). Create one with `npm run platform-admin:create -- --email=you@example.test`; it prints a generated password once. They log in at `POST /platform/auth/login` and get a 15-minute access token with no refresh token.
- **Tenant users** are invited (`POST /users/invitations`, or the owner invitation sent when a tenant is created) and set their own password at `POST /auth/invitations/accept`. No password ever lives in configuration.
- **Login** is `POST /auth/login` at the tenant's subdomain (`<slug>.<APP_BASE_DOMAIN>`), or with a `workspace` field in the body. It returns a 15-minute access token and a 30-day refresh token. `POST /auth/refresh` rotates the pair on every use; presenting a used refresh token revokes the whole chain. `POST /auth/logout` revokes the session at once.
- **Password reset** is `POST /auth/password-reset` (always 202) and `POST /auth/password-reset/confirm`.
- **Every route declares its access**: `@Public()`, `@Authenticated()` or `@RequirePermission(...)`. A route without one is refused, and a test fails if one exists. Permissions are code (`src/modules/identity/permissions.ts`); roles are data, with `owner` and `member` created for every tenant.
- Until the notification service exists, invitation and reset tokens are printed to the API's stdout as `[dev email] ...`.

Environment: `JWT_SECRET` signs access tokens (at least 32 characters, different from `APP_SECRET`), `APP_BASE_DOMAIN` is the domain tenant subdomains hang off (`localhost` locally), `LOG_LEVEL` sets the JSON log level.

## Database roles

Postgres has two login roles, created by `docker/postgres-init/01-roles.sql` when the volume is first initialised:

- `erp_owner` owns the schema and every table. Prisma Migrate uses it (`DATABASE_MIGRATE_URL`).
- `erp_app` owns nothing and is what the API connects as (`DATABASE_URL`). Its table privileges come from migrations.

If the roles are missing (for example, the volume predates the init script), recreate the volume: `docker compose down -v && docker compose up -d`, then migrate and seed again.

After changing `prisma/schema.prisma`, run `npx prisma migrate dev` and then `npx prisma generate`: Prisma 7 no longer regenerates the client during migrate.

## Tests

```bash
npx tsc --noEmit
npm run lint
npm test            # unit
npm run test:e2e    # integration, needs the Compose stack running and migrated
```

CI (`.github/workflows/ci.yml`) runs all of these against fresh Postgres and Redis containers, then builds and seeds twice.

## Conventions

- **Configuration** is read only in `src/config`. Everything else takes `ConfigService`; an invalid environment fails at boot with every problem listed.
- **Tenancy** is enforced by Postgres row-level security alone. Tenant-owned tables are reached only inside `prisma.inTenant(tenantId, tx => ...)`, which sets the tenant for one transaction; outside it they show no rows and refuse inserts. A new tenant-owned table follows `src/database/rls.sql.md`, and an e2e test fails if any table with a `tenant_id` column lacks its policy.
- **Append-only tables** (logs, ledger) call `SELECT make_append_only('<table>')` in their migration. Corrections are new rows.
- **Ids** are UUIDv7: `@default(uuid(7))` in the schema, `newId()` from `src/common/ids/uuid.ts` in code.
- **Errors** are `application/problem+json`. Validation failures list every failing field.
- **Money** is `NUMERIC(18,6)` with a currency column and serialises as a string.
- **Settings** are typed per key in `src/modules/settings/setting-keys.ts`; unknown keys and invalid values are refused.

## Before deploying

Things that work locally but must be settled for any shared environment:

- **Client addresses behind a proxy.** Password-reset rate limits are per client IP, read through Express (`@Ip()`). Behind a load balancer or reverse proxy every request appears to come from the proxy, so all users would share one limit. Configure Express's `trust proxy` for the actual proxy setup (for example `app.set('trust proxy', 1)` for a single hop) so the client address comes from `X-Forwarded-For`, and never trust that header without a proxy in front.
- **Identity email.** Invitation and password-reset tokens are printed to stdout by a development notifier, and the API refuses to boot with `NODE_ENV=production` until the notification service replaces it.
- **Sentry.** Set `SENTRY_DSN` per environment; without it, errors are logged but not reported.
