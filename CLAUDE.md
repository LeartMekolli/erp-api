# erp-api

API for an industry-agnostic, made-to-order production ERP: configurable products, step-based pricing, routing work to production partners by capability and capacity, and a configurable production workflow with quality control.

First target industry: made-to-order 3D objects (printed and cast parts), decided 2026-10-22. The core stays industry-agnostic: processes and machines are step types and partner capabilities, never code.

## Rules

- No legacy brand, company or customer names anywhere: code, comments, docs, seed data, commit messages.
- New, standalone project. No compatibility with the legacy API and no legacy data migration.
- TypeScript in strict mode.
- Industry specifics (materials, production steps, units) are configuration, not code.
- Every new route gets `@ApiDoc` (`src/docs/api-doc.ts`): a one-sentence summary, `body` and `query` from the same Zod schemas the route validates with, and `errors`. Access, 401/403 and the idempotency note are derived; never write them by hand. A new response shape is a Zod schema next to the code that builds it, with `response:` and an `expectDocumented` check in an e2e test. `test/api-docs.e2e-spec.ts` fails for any undocumented route.
- Agents never commit or push. Write the files and tell the user they are ready; the user commits. This overrides any skill step that says to commit.
- Agents never install packages and never run project tooling. This covers, at minimum: `pnpm`, `npm`, `yarn`, `npx`, `node`, `docker`, `docker compose`, `prisma`, `psql`, `redis-cli`, `jest`, `tsc`, `eslint`, `nest`, and any other package manager, build, migration, database, container or test command — in any form, including through a script alias. Write out the exact command, hand it to the user, stop, wait for their output, then continue. This applies inside plans and specs too: a step whose body is one of these commands is a step the user executes.

## Context

Read before analysing, specifying or planning:

- `docs/context/preconditions.md`: agreed stack and decisions, plus open topics.
- `docs/context/legacy-analysis.md`: what the legacy system did, what is worth keeping, and its problems.

These are reference material, not a plan. Specs and plans are produced per topic.

## Legacy source

The legacy code is a read-only reference and lives outside this repo. Ask the user for its location. Never copy legacy code, names or secrets into this repo.
