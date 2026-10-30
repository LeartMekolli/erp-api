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

Process settings for a deployment: `WORKER_IN_PROCESS=true` makes `node dist/main` also run the job consumers and scheduled jobs, for hosts with no background workers; otherwise run `node dist/worker` next to it. `TRUST_PROXY_HOPS` is the number of proxies in front of the API. `CORS_ORIGINS` lists the staff app origins allowed to call it from a browser (none by default); each workspace's customer site, set with `PUT /workspace/customer-site`, is allowed as well. `DATABASE_MIGRATE_URL` is read by the Prisma CLI only: a deployed service does not need it and should not hold it.

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

## Material prices

A feed-priced material takes its price from a daily snapshot of metal prices, plus its add-on; quotes and checks only read snapshots, never the provider. A scheduled job fetches them at 05:00 UTC, one call per workspace currency, at most `METAL_PRICE_MAX_CURRENCIES` (default 3). `METAL_PRICE_PROVIDER=fake` (the default) returns fixed prices; `metalsdev` uses [Metals.Dev](https://metals.dev) and needs `METAL_PRICE_API_KEY`, set as a secret on the host. When a feed price is missing or older than `METAL_PRICE_STALE_HOURS` (default 48), the material falls back to its stored price and holders of `catalog.write` are notified once a day.

## Catalog

Staff set up what a workspace can make and sell, through the API: units, materials (priced by hand or from the metal feed), option groups and values, rules between values (`excludes`, `requires`), categories, and products. A product is `custom` (the customer brings the design file) or `ready_made` (it pins its own measured file), and can be sized by a scale range or named sizes. `POST /catalog/products/{id}/check` answers whether a configuration can be made: accepted, with the measures scaled to the chosen size and the material's current price, or refused with every reason. `npm run seed` gives the `demo` workspace an example catalog of printed and cast parts.

A walkthrough in Swagger, as the owner:

1. `POST /catalog/categories`: "Cast metal parts", `required_measures` volume and bounding box.
2. `POST /catalog/materials`: "Silver 925" (`price_source: feed`, `feed_metal: silver`, `addon_percent: 8`, a fallback price) and "Brass" (`price_source: manual`).
3. `POST /catalog/option-groups` Material and Finish, their values (a material value names its `material_id`), and `POST /catalog/option-rules`: gold plated requires silver.
4. `POST /catalog/products`: "Custom cast part" (`custom`, range 0.5–2) and "Ring model 12" (`ready_made`, sizes S, M, L); `PUT .../options` for each, and `PUT .../design-file` for the ring with a measured STL version.
5. `POST /catalog/products/{id}/check`: brass + gold plated is refused naming the rule; silver + polished with `size: { "scale": "1.5" }` and the customer's `file_version_id` is accepted with scaled measures and the silver price.
6. `PUT /catalog/materials/{id}/price-override` for silver, then check again: the new price shows.

## Pricing

Staff set what each production step costs and how a price is built, through the API: step types (with the summary group a customer sees them under), the usual chain of steps per category (a product can have its own, and an option value can add or remove a step), step prices from typed building blocks (material, machine time, labour, a rate per measure, a fixed amount, setup per run, batch), and the adjustments: margin (per workspace, category or product), quantity discount tiers, customer groups, delivery speeds and minimum-size surcharges. `POST /pricing/quotes` checks the configuration, prices every step for the quantity, applies overhead, margin, tier, group and speed, rounds the price per piece once, and saves the quote with its breakdown; its price holds until it expires. Staff read every number at `GET /pricing/quotes/{id}`; the customer's view is `GET /pricing/quotes/{id}/summary`: material, making, finishing and the discount and speed lines, always adding up to the price. `npm run seed` also gives the `demo` workspace example pricing for its catalog.

A walkthrough in Swagger, as the owner, after the Catalog walkthrough:

1. `POST /pricing/step-types`: print pattern, casting tree, casting, polishing, plating; `PUT /pricing/step-types/{id}/prices` for each (for example casting: silver by weight with 5 % loss, plus a setup of 15; casting tree: 8 per batch, 40 per batch plus 20 g of metal).
2. `PUT /pricing/categories/{id}/steps` for "Cast metal parts", and `PUT /pricing/option-values/{id}/step-effects` so gold plated adds plating. `PUT /pricing/profile`, `PUT /pricing/discount-tiers`, `POST /pricing/delivery-speeds` (standard as default, rush).
3. `POST /pricing/quotes`: the custom cast part in silver, polished, `size: { "scale": "1.5" }`, the customer's `file_version_id`, `quantity: 1`. Then `GET /pricing/quotes/{id}`: the grams of silver and their price, each step's cost, the total.
4. The same for `quantity: 20`: less per piece.
5. `finish: gold_plated`: the plating step appears and the price rises.
6. `delivery_speed: rush`: the surcharge appears.
7. `PUT /catalog/materials/{id}/price-override` for silver: the saved quote keeps its price; a new quote uses the new one.
8. `GET /pricing/quotes/{id}/summary`: only the grouped lines.

## Customers

Customers are organisations (a brand, or one person on their own) with their own people: an owner, admins, buyers and viewers. Staff manage organisations and their people under `/customers`, invite the first person, and can quote or upload a file for a customer. Customer people log in like staff (`POST /auth/login`, or `POST /auth/google` when the workspace has set `auth.google`), hold no staff permissions, and act for one of their organisations under `/portal/customers/{customerId}/...`: its people and invitations, the published catalog plus its own products, its files, and its quotes, which always come back as the summary with plain refusal reasons. A buyer can save a quote as the organisation's own product, which reprices at current prices. `PUT /workspace/customer-site` sets the customer site that customer emails link to and that may call the API. `npm run seed` gives the `demo` workspace two demo customers, Luna Jewels (trade group: `anna@luna.example.test` owner, `ben@luna.example.test` buyer) and Mira Studio (`mira@mira.example.test`), and prints their shared password once.

A walkthrough in Swagger, after the Pricing walkthrough:

1. As the owner: `PATCH /catalog/products/{id}` with `published: true` for the custom cast part; `POST /customers` "Luna Jewels" with the trade group; `POST /customers/{id}/invitations` for Anna as `owner`.
2. `POST /auth/customer-invitations/accept` with the token from the email (Mailpit locally), a name and a password; then `POST /auth/login` as Anna.
3. As Anna: `GET /portal/me`, then `POST /portal/customers/{id}/invitations` for Ben as `buyer`; Ben accepts and logs in.
4. As Ben: `POST /portal/customers/{id}/files` with a design STL, upload it, complete it; once measured, `POST /portal/customers/{id}/quotes` for the cast part with its `file_version_id`: the summary, with Luna's discount.
5. `POST /portal/customers/{id}/products` with the quote and "Luna Moon Ring", then quote it with only options and size: the same price.
6. As another customer's person, none of it is visible: `GET /portal/customers/{theirs}/quotes` is empty and Luna's paths answer 404.

## Workflow/QC

Staff set up how pieces are made and checked, under `/workflow`: a defect catalogue, and workflows of steps, each using a step type (final QC and packing are step types nobody prices: `summary_group: null`). A step carries its checklist (choice, yes/no, number with limits, text), the defects it records with their default outcome (rework to a step, scrap, or continue), its rework targets, the photos and comment a pass and a fail need, an SOP file, an expected duration, and whether customers see it and under which name. Sending a workflow's steps adds its next version; a category gets a workflow and a product can override it. A product can only be quoted when its workflow has every step the quote prices. `POST /workflow/groups` starts a saved quote's pieces, one work order per piece, on the workflow's current version; each piece's path skips the priced steps the quote didn't price. `POST /workflow/moves` passes, fails or corrects many pieces at once behind the QC gate, and every move leaves a permanent transition row per piece. A scrapped piece is replaced at once under its number. `GET /workflow/transitions` is the filterable QC history. `npm run seed` also gives the `demo` workspace defects and a workflow for each demo category.

A walkthrough in Swagger, as the owner, after the Pricing walkthrough:

1. `POST /pricing/step-types` Final QC and Packing with `summary_group: null`; `POST /workflow/defects` porosity, scratch and crack; `POST /workflow/workflows` "Cast rings", then `PUT /workflow/workflows/{id}/steps` with print pattern → casting tree → casting → polishing → plating → final QC → packing: polishing asks for a Surface choice and a comment on every fail, final QC asks for a Weight of 4.8–5.2 g and a photo on every pass; casting, polishing and final QC are shown to customers as Casting, Finishing and Quality check. `PUT /workflow/categories/{id}/workflow` for "Cast metal parts".
2. `POST /pricing/quotes` for 10 polished silver parts, then `POST /workflow/groups` with its `quote_id`: 10 pieces at print pattern, and `GET /workflow/groups/{id}` shows the path without plating.
3. `POST /workflow/moves` with all 10 `work_order_ids`, `at_step: print_pattern`, `kind: pass`; again for casting tree and casting. `GET /workflow/work-orders/{id}`: one row per move in `history`.
4. At polishing: `kind: fail` for 3 pieces with the scratch `defect_id`, a comment and a photo; `kind: pass` for the other 7 with `answers: [{ "item": "surface", "value": "ok" }]`. The group shows 7 at final QC and 3 `in_rework` at polishing.
5. At final QC, a pass without a photo is a 400 naming `photos`; with `weight` 5.0 and a photo `file_version_id`, it goes through.
6. Fail one of the 3 with crack: it is scrapped, a replacement with the same number starts at print pattern, and the group still has 10 live pieces.
7. `kind: correction`, `to_step: final_qc` and a comment for a piece passed to packing by mistake: both rows stay in its history, and nothing counts as rework.
8. `PUT /workflow/workflows/{id}/steps` again: the running group stays on version 1; a new quote's group starts on version 2.
9. `GET /workflow/groups/{id}/customer-view`: each piece's customer-facing stage and the plain `redone` and `restarted` flags, nothing else.

## Partners

Partners are the outside workshops that make the pieces. Staff manage them under `/partners` and invite their first person; partner people log in like staff and act for their partner under `/partner-portal/partners/{partnerId}/...`. A partner sets its capabilities (step types, with pieces per job, the largest piece and capacity per day or week), closed days, the option values it offers, its limits and its own price list (staff may start it from the workspace's prices, whose numbers the partner never sees; once approved, its prices change through staff), and staff approve it with its signed agreement on file. Each workflow step is done by the partner or the workspace (`done_by`), and one step is the payout step (by default the last partner step). `GET /partners/eligible?group_id=` lists who can take a job, best score first, then cheapest, with cost, margin and room, and why the others can't. Staff offer a job, the partner accepts or declines before the deadline (`partners.routing`, 24 h by default), and an unanswered offer expires on its own; staff can withdraw an offer or move an accepted job. Partners see their jobs and move their own pieces behind the same QC gate as staff, never seeing the customer or its price. A partner is owed its job's cost once every live piece has passed the payout step (`GET /partners/{id}/owed`); staff can set another amount with a reason. Customers staff allow (`may_pick_partner`) can pick a workshop that takes direct orders, at its own price, and the job is that workshop's once it starts. Customers rate finished jobs; the score mixes quality, scrap, reliability and rating by `partners.scoreWeights`, and shows "new" until 5 jobs are finished. Each partner's load and capacity are kept daily (`GET /partners/{id}/capacity-history`). `npm run seed` gives the `demo` workspace two approved partners, Northcast Foundry (cast metal, takes direct orders: `owner@northcast.example.test`) and Layerline Prints (printed parts: `owner@layerline.example.test`), and prints their owners' shared password once.

A walkthrough in Swagger, as the owner, after the Customers walkthrough (`test/partners-slice.e2e-spec.ts` runs the same):

1. `PUT /workflow/workflows/{id}/steps` for "Cast metal parts" with packing `done_by: workspace`, so final QC is the payout step. `POST /partners` "CastCo", `POST /partners/{id}/invitations` for its `owner`; `POST /auth/partner-invitations/accept` with the emailed token, then log in: `GET /partner-portal/me`.
2. As CastCo's owner: `PUT .../capabilities` for print pattern, casting tree, casting (at most 500 pieces, 40 mm), polishing and final QC at 200 a week; `PUT .../offerings` silver and polished. As the owner: `POST /partners/{id}/prices/copy-from-workspace`; CastCo's `GET .../prices` lists those steps under `copied`, without the numbers. As CastCo's owner: `PUT .../step-types/{casting}/prices` with a setup of 30; `POST .../submit`. As the owner: `PUT /partners/{id}/agreement` and `POST /partners/{id}/approve`.
3. MetalWorks the same with a casting setup of 50 and `PATCH .../limits` `accepts_direct_orders: true`; PrintLab without polishing.
4. Quote 10 polished silver rings for Luna and `POST /workflow/groups`; `GET /partners/eligible?group_id=`: CastCo and MetalWorks with cost, margin and room; PrintLab under `ineligible`.
5. `POST /partners/jobs/{groupId}/offer` to CastCo: its room drops by 10. As CastCo, `POST .../jobs/{groupId}/decline`: staff are notified. Offer again; CastCo accepts.
6. As CastCo: `GET .../jobs/{groupId}` for the pieces, then `POST .../moves` through its steps, with the surface answer at polishing and dimensions and a photo at final QC. Nothing names Luna or her price; a pass at packing is a 409.
7. `GET /partners/{id}/owed`: `owed`, at the job's cost. A staff correction of one ring back to polishing makes it `not_yet`; passing it again restores it. A cracked ring scrapped and remade changes nothing.
8. `PATCH /customers/{id}` `may_pick_partner: true`. As Ben: `POST /portal/customers/{id}/quotes/partners` lists only MetalWorks, with its price; quote with its `partner_id`; starting it makes a `direct` job MetalWorks has at once.
9. An offer left past its deadline expires on its own (every minute), staff are notified, and the room comes back.
10. As Ben: `POST /portal/customers/{id}/jobs/{groupId}/rating` with 4 stars and a comment. `GET /partners/{id}`: the score's parts. As CastCo, `GET .../score`: the stars without the comment; once staff `POST /partners/ratings/{id}/share`, the comment too, never Luna's name.

## Orders

Customers order from the quotes they were shown, at those prices. Staff place orders under `/orders` (`order.write`), and a customer's buyer does so under `/portal/customers/{customerId}/orders`; each line names a quote of that customer, ordered once, and all lines share one delivery speed. Placing freezes the totals: the lines, the shipping method's price (`/orders/shipping-methods`), and tax from the most specific of the workspace's rates for the address (`/orders/tax-rates`: country and region, country, default). The order is numbered from 1001 and promised the delivery speed's working days on the `business.calendar` setting (Monday to Friday until 17:00 when unset; `closedDates` are skipped). Every line starts at once as one work order group: at the workshop the customer picked, as its direct job, else in-house until staff offer it. If any line can't start, nothing is created. A quote past its hold (`quote_valid_hours` on the pricing profile) is priced again: unchanged, the order uses the new quote; changed or refused, the 409 has `code: 'price_changed'` with each line's new quote to confirm. Unless `partners.routing.splitOrderLines` is on, every line of one order that goes to a partner goes to the same one: offers, moves and picks of another are refused. An order's and its lines' states follow the pieces. Staff cancel lines or the whole order until it ships, setting what an accepted partner is owed (`partner_owed`, else nothing); the customer cancels the whole order while no piece has moved. Staff ship a ready order with its courier and tracking number and mark it delivered (`order.ship`, owners only). Customers are told when their order is placed, shipped, delivered or cancelled by staff, and staff of each new order. Customers never see a partner, a cost or a margin; partners never see the order, its number, its other lines or the customer. A product can be an assembly, made of ready-made parts (`PUT /catalog/products/{id}/parts`, one level only). Ordering one is a single line with a sub-line per part, each part its own work order group made at the part's own partner; the set itself is put together in-house, and its parts sit outside the one-partner rule. The set can't pass its first step until every live piece of every part is finished (a scrapped piece waits for its remake), and is priced as its own steps plus a quote per part, shown to the customer as one price. Every partner job has a due date: the order's promised date less `orders.scheduling.bufferDays` working days (2 when unset), one more (`assemblyAllowanceDays`) for a part of an assembly, never before today; staff can give another date when offering, and a job that isn't an order line has none unless staff give one. The partner sees its `due_on`, and the share of jobs finished by their due date is the on-time part of its score. Staff, the customer's people and the partner talk on an order under `.../comments` (`GET`, `POST`, and a signed link per attachment): the customer sees staff comments not marked `for_partner` and its own people's; a partner sees only the comments staff mark for it on a job it holds now, and its own, never the customer or the order; comments can't be edited or deleted. `npm run seed` gives the `demo` workspace the `courier` (9.90) and `collect` (free) shipping methods, a default tax rate of 0 and Germany at 19 %, a Monday to Friday calendar, job due dates of 2 days (1 more for a part), and the `pendant_set` (a pendant at size M and a bail, on a placeholder design, with its own assembly step, a bought chain and an Assemblies workflow).

A walkthrough in Swagger, after the Partners walkthrough, on the demo data (`test/orders-slice.e2e-spec.ts` runs the same):

1. As the owner: `PUT /pricing/profile` with `quote_valid_hours: 4`; `PUT /settings/business.calendar` Monday to Friday, 9 to 17; `PUT /orders/tax-rates` with a default of 0 and `DE` at 19; `GET /orders/shipping-methods` and `GET /pricing/delivery-speeds` (10, 5 and 2 working days).
2. As Ben: `POST /portal/customers/{id}/quotes` for 10 polished brass parts at `standard`, then `POST /portal/customers/{id}/orders` with its `quote_id`, a German address and `courier`. The order is 1001, with its promised date, 19 % tax on the lines and shipping, and its line in production with 10 pieces.
3. A quote past its 4 hours with an unchanged price still orders, with a new quote. After `PUT /pricing/profile` with a higher margin, another lapsed quote is a 409 `price_changed`; ordering with `lines[0].quote.id` succeeds.
4. As the owner: `GET /orders/{id}`: the line has no partner. `POST /partners/jobs/{groupId}/offer` to Northcast; as Northcast's owner, `GET /partner-portal/partners/{id}/jobs` lists it, never naming Luna, the order or its price.
5. As Ben: `POST /portal/customers/{id}/orders/{id}/cancel` an order nothing has moved on. Once a piece of the offered order has passed print pattern he can't, but `POST /orders/{id}/cancel` as the owner can, and Northcast's offer is withdrawn. (The offer's `due_on` is the promised date less 2 working days, and Northcast sees it.)
6. As the owner: `POST /workflow/moves` every piece of order 1001 through its steps (the surface answer at polishing, dimensions and a photo at final QC). `GET /orders/{id}`: `ready`. `POST /orders/{id}/ship` with a courier and tracking number: Luna is told and sees them; `POST /orders/{id}/deliver`.
7. `PATCH /customers/{id}` `may_pick_partner: true`. As Ben: two lines quoted with Northcast's `partner_id` start as Northcast's direct jobs. With `PUT /settings/partners.routing` `splitOrderLines: false`, a line at Northcast and a print picked at Layerline can't be one order (409 `lines.1`). With Northcast suspended, an order picked there is refused, and nothing is created.
8. An assembly: as Ben, quote and order 2 `pendant_set` in brass. The order has one line with two parts. `POST /workflow/moves` `pass` at `assembly` for the line's pieces is a 409 until every piece of the pendant and the bail is finished; then assembly, final QC and packing pass and the order is `ready`.
9. Due dates and comments: offer a new line to Northcast and, as Northcast, accept it. As Ben, `POST /portal/customers/{id}/orders/{id}/comments`; as the owner, `POST /orders/{id}/comments` twice on the line, one with `for_partner: true`. `GET .../jobs/{groupId}/comments` as Northcast lists only that one, never Luna. Once Northcast's pieces pass every step, `GET .../score` shows `on_time` at 1.

## Payments

Customers pay through each workspace's own Stripe account; partners are paid through Stripe Connect Express accounts. Every movement of money is a journal in an append-only, double-entry ledger (`GET /payments/ledger`): its lines sum to zero, or the database refuses it, and a mistake is corrected with a reversal. A customer pays first (the default) or later (`PUT /customers/{id}/payment-terms`: days to pay and a credit limit). A pay-first order, or a pay-later one past its limit, waits for payment: its workshop's capacity is held, nothing is made, and the customer gets a Checkout link (`payments.collection.payWithinHours`, then it is cancelled). Paid, it starts as if placed then; staff can release a held order with a reason, or record a payment made outside Stripe (`POST /orders/{id}/paid-by-hand`). A pay-later order is invoiced through Stripe when it ships, due in its days to pay, and staff are told of an overdue one. Cancelling a paid order refunds what staff decide, suggested from the work partners are owed for (`GET /orders/{id}/refund-suggestion`); a customer cancelling gets everything back, and so does a payment arriving for an order already cancelled. A partner connects its payout account through a Stripe onboarding link; staff pay it what is due (owed less paid) in one transfer, never twice, and a refused or reversed transfer makes the jobs due again. Webhooks arrive at `/webhooks/payments/{tenantId}` and `/webhooks/payments/{tenantId}/connect`, each checked against its own signing secret, stored once and applied by the worker. `PAYMENT_PROVIDER=fake` (the default, and every test) never calls Stripe. `npm run seed` makes Luna Jewels pay first and adds Brightline paying later (30 days, 5,000.00); with the `DEMO_STRIPE_*` test keys it also sets the demo's payment account and gives Northcast Foundry a payout account to onboard.

### Payments in test mode

1. In the Stripe dashboard, in test mode: copy the secret and publishable keys, and turn on Connect (Express).
2. Set `PAYMENT_PROVIDER=stripe`, and either the four `DEMO_STRIPE_*` keys before `npm run seed`, or `PUT /payments/account` as the owner. `GET /payments/account` shows the two webhook URLs.
3. Forward webhooks with the Stripe CLI, one listener per endpoint; each prints its signing secret (`whsec_...`) to set as `webhook_secret` and `connect_webhook_secret`:

   ```bash
   stripe listen --forward-to localhost:3000/webhooks/payments/<tenantId>
   stripe listen --forward-connect-to localhost:3000/webhooks/payments/<tenantId>/connect
   ```

4. Test cards: `4242 4242 4242 4242` pays, `4000 0000 0000 9995` is declined, `4000 0025 0000 3155` asks for 3-D Secure; any future date and any CVC. A transfer fails for want of balance until test charges have settled, or with a card such as `4000 0000 0000 0077` that adds to the available balance at once.

A walkthrough in Swagger, on the demo data with the keys set (`test/payments-slice.e2e-spec.ts` runs the same with the fake provider; it is the spec's "Done when"):

1. As the owner: the keys are set; `PUT /customers/{id}/payment-terms` Brightline `pay_later`, 30 days, `credit_limit: "5000.00"`.
2. As Anna (Luna, pay first): order a part. The order is `awaiting_payment` with a `pay_url`; nothing is in production. Pay with the test card: it starts, and `GET /orders/{id}/payments` shows it billed, paid and Stripe's fee, each journal balanced.
3. A second order left unpaid past `pay_by` (set `payments.collection.payWithinHours: 1`) is cancelled within a minute, and Anna is told.
4. `stripe events resend <id>` for the Checkout event: nothing changes. A request with a bad `Stripe-Signature`: 400.
5. As staff for Brightline: an order starts at once. Make it ready and `POST /orders/{id}/ship`: an invoice is created; pay it from its page with the test card, and the order is `paid`. With a low limit, the next order waits for payment; `POST /orders/{id}/release` with a reason starts it.
6. As Anna: cancel a paid order before any piece moved: refunded in full. As staff: a paid order whose partner has done some work: `GET /orders/{id}/refund-suggestion` is the price less what the partner is owed; `POST /orders/{id}/cancel` with `partner_owed` and a different `refund.amount`. `GET /payments/ledger` balances.
7. As Northcast's owner: `POST /partner-portal/partners/{id}/payout-account/link`, complete Stripe's test onboarding; `GET .../payout-account` becomes `ready`.
8. As staff: `GET /partners/{id}/owed` lists Northcast's two owed jobs, Brightline's with `customer_paid: false`. `POST /partners/{id}/payouts`: one transfer for both. Again: 409 `Nothing to pay`. Northcast sees the payout under `GET /partner-portal/partners/{id}/payouts`.
9. With too little test balance, a transfer is refused: the payout is `failed`, staff are told, and the jobs are due again.
10. The ledger: `UPDATE` or `DELETE` on `ledger_journal` or `ledger_line` is refused, and every journal sums to zero.

### Plans and credits

Plans are workspace data (`/payments/plans`): a price per month and per year, a discount applied after the customer group's, the delivery speeds offered beyond the workspace's default one (each at the speed's own surcharge or the plan's), monthly credits, a member limit and switches (`progress_emails`, `pay_later`). Every workspace has a free default plan, Starter, that every customer without a subscription is on. A paid plan is a Stripe product with a Stripe price per amount; changing a price adds one, and subscribers keep theirs. A customer's owner subscribes through a Stripe checkout and manages cards and invoices in Stripe's billing portal. The subscription is only ever written from Stripe's webhooks: an upgrade applies once its prorated payment is taken, a downgrade or the drop to Starter at the period end, and a late payment keeps the plan until Stripe gives up.

Credits are whole units the AI tools will spend, held in three insert-only tables (grants, spends and their entries); a balance is always worked out, never stored. They come from the plan's monthly allowance, packs bought at any plan (`/payments/credit-packs`), campaigns that grant automatically to targeted plans and customers within a budget (`/payments/campaigns`), and staff grants with a reason. Spending takes campaign and staff credits first, then the allowance, then packs, the soonest to expire first, and never below zero. `npm run seed` gives Starter 10 credits and 2 members without pay later, adds Pro and Business, packs of 100 and 500 credits and the "Welcome to Pro" campaign; with the `DEMO_STRIPE_*` keys the plans are published.

### Plans and credits in test mode

On top of [Payments in test mode](#payments-in-test-mode):

1. `stripe listen` needs no new endpoint: subscription, invoice and checkout events arrive at the same `/webhooks/payments/<tenantId>`.
2. Turn on Stripe's customer portal in test mode (Settings → Billing → Customer portal), or `POST /portal/customers/{id}/billing-portal` fails at Stripe. Turn payment methods and invoice history on, and **switching plans and cancelling off**: plan changes go through our API, which withdraws a pending upgrade before any new choice.
3. Settings → Billing → Subscriptions → Manage failed payments: after all retries, **cancel the subscription**. With "leave as unpaid" a customer keeps its plan for ever, since `unpaid` counts as past due here.
4. A failed renewal, on a test clock (Billing → Test clocks): create the customer on the clock, subscribe it, make `4000 0000 0000 0341` its default card (it attaches, then every charge is declined), and advance the clock past the period end. Advancing it past the last retry is Stripe giving up.

A walkthrough in Swagger, on the demo data with the keys set (`test/payments-2-slice.e2e-spec.ts` runs the same with the fake provider; it is the spec's "Done when"):

1. As the owner: `GET /payments/plans` lists Starter, Pro and Business, `published: true`. `PATCH /payments/plans/{id}` Pro's `yearly_price`: a new Stripe price exists, and the old one is kept for its subscribers.
2. As Anna (Luna, on Starter): a quote with `delivery_speed: express` is refused naming Starter; without it, there is no plan discount. `GET /portal/customers/{id}/credits` shows Starter's 10 credits once the allowance job has run (every 15 minutes).
3. As Anna: `POST /portal/customers/{id}/credit-packs/{packId}/buy` and pay with `4242 4242 4242 4242`. The 100 credits arrive once, and `GET /payments/ledger` shows the pack billed, paid and Stripe's fee, each balanced.
4. Invite an owner to Brightline and, as them, `POST /portal/customers/{id}/subscription/checkout` for Pro monthly and pay. `GET .../subscription` is `active` on Pro; the credits show Pro's 100 and the campaign's 50; a staff quote for Brightline has the group line, then Pro's, and offers express.
5. `POST .../subscription/change` to Business: 202, and Business once Stripe has taken the difference, with a top-up of 300 credits and rush at 20 %. A change to Pro is shown as `change` on the period end; choosing Business again takes it back.
6. A failed renewal (above): `past_due`, still Business, and Brightline is told. Once Stripe gives up: Starter, staff are told (`pay_later: yes`), and the pack and campaign credits are still there.
7. Credits are spent by the AI tools, which aren't built yet: the slice test spends through `CreditsService`, campaign first, then the allowance, then packs; too much is refused, and a give-back restores them.
8. `POST /payments/campaigns` for three named customers, 50 credits each, budget 100, then `.../activate`: two are granted, `budget_left` is 0, and staff are told once.
9. `stripe events resend <id>` for any subscription or invoice event: nothing changes. `UPDATE` or `DELETE` on `credit_grant`, `credit_spend` or `credit_entry` is refused, like the money ledger.

## AI

Staff get a dashboard and Cmd+K. `GET /reports/dashboard` (`report.read`) shows this week against last week (orders, on-time delivery, hours per step, the defect rate, top customers, customers ordering less than usual, slow payers, how full each partner is), recomputed every 15 minutes in the workspace's time zone, and a live "needs attention" list (orders at risk, overdue jobs and invoices, orders waiting for payment or held, nearly full partners, unanswered offers, a jump in defects). Money figures need `payment.read` and partner figures `partner.read`. Managers, staff who also hold `payment.read` and `partner.read`, see a morning briefing written by the AI at 07:00 in the workspace's time zone: a short summary and up to five suggestions, each opening a screen for a person to act on. They can refresh it (`POST /reports/dashboard/briefing`, once every 15 minutes) and dismiss a suggestion for 14 days.

Cmd+K searches orders by number, customers and partners by name and articles by title (`GET /search?q=`), and answers questions (`POST /ai/ask`, `ai.use`; poll `GET /ai/runs/{id}`). The AI reads through read-only tools that see only what the person asking may see, answers only from what they returned, and cites the records it used; it may propose one action, never take it. Staff with `knowledge.write` write the knowledge base (`/knowledge/articles`, Markdown with PDF or text attachments) that the AI answers how-to questions from.

Every AI call is a run, logged insert only with its model, tokens and cost (`GET /ai/runs`, `settings.read`). A workspace has no AI until a platform admin sets its monthly limit in USD (`PUT /platform/tenants/{id}/ai-limit`, `{ "monthly_usd": "20.00" }`; `null` turns it off). Asks and refreshes are refused with a 409 once the month's spend reaches it, and staff with `settings.write` are told at 80 % and at 100 %. The AI month is the UTC calendar month.

`AI_PROVIDER=fake` and `VECTOR_STORE=fake` (the defaults, and every test) never call Anthropic or Pinecone. For the real thing:

1. `AI_PROVIDER=claude`, `ANTHROPIC_API_KEY`, and optionally `AI_MODEL` (default `claude-haiku-4-5`; the models and their prices are in `src/modules/ai/ai-models.ts`).
2. In Pinecone, create an index for an embedding model (integrated embedding), with its field map embedding `text`. Set `VECTOR_STORE=pinecone`, `PINECONE_API_KEY` and `PINECONE_INDEX`. Each workspace gets its own namespace, `ws_<workspace id>`.
3. `npm run knowledge:reindex` rebuilds the index from every published article, for a new index or after a change of embedding model.
4. `AI_BRIEFINGS=false` stops the scheduled briefing only; managers can still refresh.

`npm run seed` gives the demo workspace a 20.00 USD limit and three published articles: "Handling a failed casting QC", "Offering a job to a partner" and "Chasing an overdue invoice"; the worker indexes them.

A walkthrough in Swagger, on the demo data with real keys (`test/ai-slice.e2e-spec.ts` runs the same with the fakes; it is the spec's "Done when"):

1. As the platform admin: `PUT /platform/tenants/{id}/ai-limit` with `20.00` for the demo workspace.
2. As the owner: `GET /reports/dashboard` shows this week against last week, the attention list and, after `POST /reports/dashboard/briefing` and a few seconds, the briefing with its suggestions, each with its records labelled.
3. As a staff member without `payment.read`: the dashboard has no revenue, no invoices and no briefing.
4. As the owner: `POST /reports/dashboard/suggestions/{id}/dismiss`; the suggestion is gone and isn't suggested again for 14 days.
5. Cmd+K: `GET /search?q=1042` finds the order and `?q=Northcast` the partner. `POST /ai/ask` "which of Brightline's orders are late?" answers with the orders, linked; "how do we handle a failed casting QC?" answers from the seeded article, cited; "offer the waiting cast job to Layerline" proposes `offer_job`.
6. Asking about revenue without `payment.read` gets an answer without it.
7. As the platform admin: lower the limit below the month's spend. The next ask and refresh are 409, the dashboard shows `ai: { enabled: false, reason: "limit_used" }`, and staff are told once.
8. `GET /ai/runs` lists every run with its tokens and cost. `UPDATE` or `DELETE` on `ai_run` or `ai_run_result` is refused.

## API docs

With `API_DOCS=true`, the API serves Swagger docs at `/docs` (the OpenAPI document is at `/docs/openapi.json`); without it both answer 404. Every endpoint shows a short description, what it accepts, its error statuses and who may call it. Request shapes come from the Zod schemas the routes validate with, access from the route markers. The main responses (login, refresh, `/me`, files, the feed, the tenant list) are shown as schemas that the e2e tests check real responses against; the others are described in words. To try endpoints, call `POST /auth/login` (or `POST /platform/auth/login`), paste the `access_token` into **Authorize**, then call anything. Uploading the file bytes themselves goes straight to storage through the signed link, outside the docs.

Adding a route: give it `@ApiDoc({ summary, body, query, response, errors })` next to its access marker. `test/api-docs.e2e-spec.ts` fails for any route without a summary, access or a request body schema where it reads one.

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
- **Migrations before code.** The running application never holds the owner's password (ADR 0001), so it can't migrate itself. On every push to `master`, CI's `migrate-staging` job runs `prisma migrate deploy` once the tests pass, with `STAGING_DATABASE_MIGRATE_URL` (the owner on Neon's direct host, not `-pooler`) from the GitHub `staging` environment's secrets. Set Render's Auto-Deploy to **After CI Checks Pass**, so the new code starts only on a migrated database. Migrations stay additive: the version still running must work on the new schema until Render replaces it.
- **Email.** Point `SMTP_URL` at the provider's SMTP relay (on Render's free tier, port 2525), set `MAIL_FROM` to an address verified with it, and set `WEB_URL_TEMPLATE` to the web app's URL. Run the worker next to the API, or set `WORKER_IN_PROCESS=true`: without it, nothing is sent.
