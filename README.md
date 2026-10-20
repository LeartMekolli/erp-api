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

Uploaded files go to MinIO, which stands in for hosted S3-compatible storage locally and in CI. `docker compose up` starts it and `minio-init` creates the private bucket `erp-files`. Browse it at http://localhost:9001 (`minio` / `minio-password`). MinIO no longer publishes images, so Compose uses Chainguard's rebuild, pinned by digest; to update it, pull `cgr.dev/chainguard/minio:latest` (and `minio-client:latest-dev`), then replace the digests in `docker-compose.yml`.

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

Process settings for a deployment: `WORKER_IN_PROCESS=true` makes `node dist/main` also run the job consumers and scheduled jobs, for hosts with no background workers; otherwise run `node dist/worker` next to it. `TRUST_PROXY_HOPS` is the number of proxies in front of the API. `CORS_ORIGINS` lists the browser origins allowed to call it (none by default). `DATABASE_MIGRATE_URL` is read by the Prisma CLI only: a deployed service does not need it and should not hold it.

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
2. The client `PUT`s the bytes straight to storage, to a key under `uploads/`. The link lives 15 minutes and accepts exactly the declared size and type. It can be used again until it expires, but it only ever writes the upload key.
3. `POST /files/:id/versions/:v/complete` checks storage holds what was declared (409 if not), claims the version (`completing`), copies the object inside storage to its final key under `files/`, checks the copy, marks the version `uploaded` and queues `file.measure`. What is measured and downloaded is the copy, which no link can write; the upload key is deleted afterwards. A repeated or simultaneous complete returns the version as it is, and a completion stuck for 5 minutes is handed back to `pending`.
4. The worker computes the SHA-256, runs the measurer registered for the content type (`src/modules/files/measurers.ts`; only a no-op ships, real ones come with Catalog), stores the measures and tells the uploader by email and in the feed (`file.measured`).
5. `GET /files/:id` shows the versions with their measures; `GET /files/:id/versions/:v/url` (`file.read`) returns a 5-minute download link. PNG, JPEG, GIF, WebP and PDF open in the browser; everything else downloads.

Storage keys are `files/<tenant>/<file>/<version>` (the checked object) and `uploads/<tenant>/<file>/<version>` (where clients upload), never a client's file name. The bucket is private: files leave it only through signed links.

Environment: `S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE` (`true` for MinIO) point at any S3-compatible storage. `S3_PUBLIC_ENDPOINT` is optional: the address signed links use when clients reach storage elsewhere than the API does. `FILE_MAX_BYTES` caps uploads (default 100 MiB, at most 5 GiB, the largest single upload S3 and R2 accept). Not every S3-compatible service supports a conditional `PUT`, so write-once comes from the copy on completion, not from storage.

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

- **Client addresses behind a proxy.** Password-reset rate limits are per client IP, read through Express (`@Ip()`). Behind a load balancer or reverse proxy every request appears to come from the proxy, so all users would share one limit. Set `TRUST_PROXY_HOPS` to the number of proxies in front of the API (for example `1` for a single hop) so the client address comes from `X-Forwarded-For`. Leave it at `0` without a proxy in front: the header is then never trusted.
- **Sentry.** Set `SENTRY_DSN` per environment; without it, errors are logged but not reported. `SENTRY_ENVIRONMENT` tags events (default `NODE_ENV`), so a staging service running with `NODE_ENV=production` reports as `staging`. `POST /platform/diagnostics/error` (platform admins only) raises a deliberate error to prove the path.
- **File storage.** One private bucket per environment, with no public access. Point the `S3_*` variables at it (`S3_FORCE_PATH_STYLE=false` for a hosted service, `S3_REGION` as the provider signs it) with a key limited to that bucket. Allow browser `PUT` and `GET` from the web app's origin with the `content-type` header in the bucket's CORS rules, or browsers cannot upload. Add a lifecycle rule that expires the `uploads/` prefix after a day or two, so abandoned upload keys do not pile up; where the provider keeps old versions of deleted files (Backblaze B2), also keep only the last version.
- **Email.** Point `SMTP_URL` at the provider's SMTP relay (on Render's free tier, port 2525), set `MAIL_FROM` to an address verified with it, and set `WEB_URL_TEMPLATE` to the web app's URL. Run the worker next to the API, or set `WORKER_IN_PROCESS=true`: without it, nothing is sent.
