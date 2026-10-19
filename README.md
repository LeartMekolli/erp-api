# ERP API

API for an industry-agnostic, made-to-order production ERP: configurable products, step-based pricing, routing work to production partners, and a configurable production workflow with quality control. Industry specifics are configuration, not code.

## Requirements

- Node.js 24
- Docker, for Postgres 16, Redis 7, Mailpit and MinIO

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

Emails sent locally go to Mailpit, started by `docker compose up`; read them at http://localhost:8025. Nothing reaches a real inbox.

Uploaded files go to MinIO, which stands in for Cloudflare R2 locally and in CI. `docker compose up` starts it and `minio-init` creates the private bucket `erp-files`. Browse it at http://localhost:9001 (`minio` / `minio-password`). MinIO no longer publishes images, so Compose uses Chainguard's rebuild, pinned by digest; to update it, pull `cgr.dev/chainguard/minio:latest` (and `minio-client:latest-dev`), then replace the digests in `docker-compose.yml`.

Background jobs run in a separate process. In a second terminal:

```bash
npm run start:worker:dev
```

It serves no HTTP and builds into `dist-worker/`, so its watcher and the API's never delete each other's output. In production, run `npm run start:worker:prod` (or `node dist/worker`) next to the API; the web process only enqueues.

The seed creates a platform admin (`admin@example.test`, password printed once) and two tenants, `demo` and `sandbox`, each with an owner invitation sent by email: with the worker running, it appears in Mailpit at http://localhost:8025. It is safe to run again. To create another tenant:

```bash
npm run tenant:create -- --name="Acme Print" --slug=acme-print --owner-email=owner@acme.example [--currency=EUR] [--locale=en] [--timezone=UTC]
```

## Running everything in Docker

The API and the worker can run in Compose too, built from the `Dockerfile` (one image, two commands). This is how a deployment runs them, and it checks that the whole system starts from nothing:

```bash
docker compose down -v
docker compose --profile app up -d --build
```

`migrate` applies the migrations and the seed, then exits; `api` (port 3000) and `worker` start after it, once `minio-init` has created the bucket. Inside Compose the API reaches MinIO as `minio:9000`, and `S3_PUBLIC_ENDPOINT=http://localhost:9000` makes the links it signs work from your browser. `docker compose ps -a` shows `migrate` as exited (0) and `api` as healthy. The seed's invitation emails appear in Mailpit, sent by the containerised worker. Stop the `app` services before going back to `npm run start:dev`, which needs port 3000:

```bash
docker compose --profile app stop api worker
```

## Authentication

- **Platform admins** act across tenants (create, list, suspend). Create one with `npm run platform-admin:create -- --email=you@example.test`; it prints a generated password once. They log in at `POST /platform/auth/login` and get a 15-minute access token with no refresh token.
- **Tenant users** are invited (`POST /users/invitations`, or the owner invitation sent when a tenant is created) and set their own password at `POST /auth/invitations/accept`. No password ever lives in configuration.
- **Login** is `POST /auth/login` at the tenant's subdomain (`<slug>.<APP_BASE_DOMAIN>`), or with a `workspace` field in the body. It returns a 15-minute access token and a 30-day refresh token. `POST /auth/refresh` rotates the pair on every use; presenting a used refresh token revokes the whole chain. `POST /auth/logout` revokes the session at once.
- **Password reset** is `POST /auth/password-reset` (always 202) and `POST /auth/password-reset/confirm`.
- **Every route declares its access**: `@Public()`, `@Authenticated()` or `@RequirePermission(...)`. A route without one is refused, and a test fails if one exists. Permissions are code (`src/modules/identity/permissions.ts`); roles are data, with `owner` and `member` created for every tenant.
- **Invitation and password-reset emails** go through the notification service and the worker. Their links point at `WEB_URL_TEMPLATE` with the token after `#token=`.

Environment: `JWT_SECRET` signs access tokens (at least 32 characters, different from `APP_SECRET`), `APP_BASE_DOMAIN` is the domain tenant subdomains hang off (`localhost` locally), `LOG_LEVEL` sets the JSON log level, `QUEUE_PREFIX` namespaces the job queues in Redis (default `erp`), `SMTP_URL` and `MAIL_FROM` set where email goes and who it is from, and `WEB_URL_TEMPLATE` is the web app's address for links in emails, with `{tenant}` standing for the slug.

## Files

One file service for every module; the API never handles file bytes.

1. `POST /files` (`file.write`) with `{ kind, name, content_type, size, declared_unit? }` creates the file and a pending version 1, and returns a signed upload: a URL, and the headers the `PUT` must carry. `POST /files/:id/versions` adds the next version the same way.
2. The client `PUT`s the bytes straight to storage. The link lives 15 minutes and accepts exactly the declared size and type, once: a second upload to the same version is refused (412), so the bytes that were checked are the bytes that stay.
3. `POST /files/:id/versions/:v/complete` checks storage holds what was declared (409 if not), then queues `file.measure`.
4. The worker computes the SHA-256, runs the measurer registered for the content type (`src/modules/files/measurers.ts`; only a no-op ships, real ones come with Catalog), stores the measures and tells the uploader by email and in the feed (`file.measured`).
5. `GET /files/:id` shows the versions with their measures; `GET /files/:id/versions/:v/url` (`file.read`) returns a 5-minute download link. PNG, JPEG, GIF, WebP and PDF open in the browser; everything else downloads.

Storage keys are `<tenant>/<file>/<version>`, never a client's file name. The bucket is private: files leave it only through signed links.

Environment: `S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE` (`true` for MinIO) point at any S3-compatible storage. `S3_PUBLIC_ENDPOINT` is optional: the address signed links use when clients reach storage elsewhere than the API does. `FILE_MAX_BYTES` caps uploads (default 100 MiB).

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

CI (`.github/workflows/ci.yml`) runs all of these against fresh Postgres, Redis, Mailpit and MinIO containers, then builds and seeds twice. `test/foundation-slice.e2e-spec.ts` runs the foundation's ten acceptance steps end to end.

## Conventions

- **Configuration** is read only in `src/config`. Everything else takes `ConfigService`; an invalid environment fails at boot with every problem listed.
- **Tenancy** is enforced by Postgres row-level security alone. Tenant-owned tables are reached only inside `prisma.inTenant(tenantId, tx => ...)`, which sets the tenant for one transaction; outside it they show no rows and refuse inserts. A new tenant-owned table follows `src/database/rls.sql.md`, and an e2e test fails if any table with a `tenant_id` column lacks its policy.
- **Append-only tables** (logs, ledger) call `SELECT make_append_only('<table>')` in their migration. Corrections are new rows.
- **Ids** are UUIDv7: `@default(uuid(7))` in the schema, `newId()` from `src/common/ids/uuid.ts` in code.
- **Errors** are `application/problem+json`. Validation failures list every failing field.
- **Money** is `NUMERIC(18,6)` with a currency column and serialises as a string.
- **Settings** are typed per key in `src/modules/settings/setting-keys.ts`; unknown keys and invalid values are refused.
- **Jobs** are declared in `src/jobs/registry.ts` with their payload schema and id rule, and handled by a provider marked `@HandlesJob('<name>')`. The API only enqueues; the worker runs them, retries with backoff, and leaves jobs that keep failing in the failed list (`GET /platform/jobs/failed`). Payloads carry ids, never secrets or message content.
- **Notifications** are raised with `NotificationsService.raise(tenantId, event, subject, variables)` after the change they describe has committed. Events, their audiences and default wording live in `src/modules/notifications/catalogue.ts`; tenants override the wording, never the audience.
- **Idempotency.** A tenant-scoped `POST` may send an `Idempotency-Key` header. Repeating it with the same request replays the first response (`Idempotent-Replayed: true`); the same key with a different request is a 409. Failed requests do not use up the key.

## Before deploying

Things that work locally but must be settled for any shared environment:

- **Client addresses behind a proxy.** Password-reset rate limits are per client IP, read through Express (`@Ip()`). Behind a load balancer or reverse proxy every request appears to come from the proxy, so all users would share one limit. Configure Express's `trust proxy` for the actual proxy setup (for example `app.set('trust proxy', 1)` for a single hop) so the client address comes from `X-Forwarded-For`, and never trust that header without a proxy in front.
- **Sentry.** Set `SENTRY_DSN` per environment; without it, errors are logged but not reported.
- **File storage.** Create one Cloudflare R2 bucket per environment with no public access (no public bucket URL, no custom domain). Set `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=false`, the bucket name, and an API token limited to that bucket. Add a CORS rule allowing `PUT` and `GET` from the web app's origin with the `content-type` and `if-none-match` headers, or browsers cannot upload.
- **Check that R2 refuses a second upload.** Uploads are write-once through a signed `If-None-Match: *` header; MinIO enforces it, and the tests prove that only against MinIO. Before going live, start an upload, `PUT` the bytes twice with the same link: the second must answer 412. If it does not, a file could be replaced after it was measured; switch to copying the object to a final key on completion before going live.
- **Email.** Point `SMTP_URL` at the real provider (Resend's SMTP endpoint), set `MAIL_FROM` to an address on a domain verified with it, and set `WEB_URL_TEMPLATE` to the web app's URL. Run the worker next to the API: without it, nothing is sent.
