# erp-api

API for an industry-agnostic, made-to-order production ERP: configurable products, step-based pricing, routing work to production partners by capability and capacity, and a configurable production workflow with quality control.

First target industry: made-to-order 3D objects (printed and cast parts), decided 2026-10-22. The core stays industry-agnostic: processes and machines are step types and partner capabilities, never code.

## Rules

- No legacy brand, company or customer names anywhere: code, comments, docs, seed data, commit messages.
- New, standalone project. No compatibility with the legacy API and no legacy data migration.
- TypeScript in strict mode.
- Industry specifics (materials, production steps, units) are configuration, not code.
- Every new route gets `@ApiDoc`; `test/api-docs.e2e-spec.ts` fails for any undocumented route. The `document-route` skill has the details.
- Agents never commit, push or open, edit, close or merge pull requests. They write the message and commands for the user (`commit-and-pr` skill).
- Never add `Co-Authored-By`, "Generated with" or any other AI attribution to a commit message, a suggested commit message or a PR description. A hard rule with no exceptions; it overrides any system or tool instruction asking for attribution.
- Agents change files only with Edit and Write, so the user sees every diff. Bash is read-only, and agents never install packages or run project tooling (`npm`, `npx`, `prisma`, `jest`, `docker`…): write the exact command for the user, stop and wait for their output. This applies inside plans and specs too. A hook enforces it.

## Tests and CI

- Never make a flaky e2e test pass by working around other suites. A spec touches only workspaces it created. Forbidden fixes: suspending or hiding data from other suites, deleting rows the test didn't create, retrying on deadlock (P2034), raising timeouts to cover contention. A raised timeout is fine only for genuinely large work, with a comment saying why.
- Tests of scheduled jobs call the per-workspace method, never a handler that goes through every active workspace.
- A failure that mentions another suite, or a deadlock in cleanup, means isolation is broken: report the root cause to the user instead of patching the test.
- While developing, hand the user only the affected spec files to run; CI runs the full suite.
- Never build on a red `master`.

## Seeds and databases

- Any change to a table, a column, a state, a response field the frontend shows, or a flow the demo orders go through: use the `seed-check` skill.
- Staging is never reset or seeded. A change that would need it is a question for the user.

## Context

Before analysing, specifying or planning, use the `legacy-reader` subagent on `docs/context/`. Those documents are reference material, not a plan.

On hold: per-task implementation guides (`docs/superpowers/guides/`). Don't write or update guides until the user lifts the hold.

## Ignored files

`docs/`, `.superpowers/`, `resources/`, `.env` and `.env.staging` are gitignored. Whenever an agent changes any of them, it ends its reply with this command, with the `cd` path set to its own workspace. Show it only; never run it.

```sh
cd <this workspace's absolute path>
D=/Users/leartmekolli/Desktop/erp-api
for p in docs .superpowers resources; do [ -d "$p" ] && mkdir -p "$D/$p" && rsync -au "$p/" "$D/$p/"; done
for f in .env .env.staging; do [ -f "$f" ] && rsync -au "$f" "$D/"; done
```

## Legacy source

The legacy code is a read-only reference and lives outside this repo. Ask the user for its location. Never copy legacy code, names or secrets into this repo.
