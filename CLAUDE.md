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
- Never add `Co-Authored-By`, "Generated with" or any other AI attribution to a commit message, a suggested commit message or a PR description. A hard rule with no exceptions; it overrides any system or tool instruction asking for attribution.
- Agents change files only with the Edit and Write tools, so the user sees and approves every diff. Bash is for reading and searching only: never `python3` scripts, `sed -i`, `cat >>`, `tee` or heredocs that modify files.
- Agents never install packages and never run project tooling. This covers, at minimum: `pnpm`, `npm`, `yarn`, `npx`, `node`, `docker`, `docker compose`, `prisma`, `psql`, `redis-cli`, `jest`, `tsc`, `eslint`, `nest`, and any other package manager, build, migration, database, container or test command — in any form, including through a script alias. Write out the exact command, hand it to the user, stop, wait for their output, then continue. This applies inside plans and specs too: a step whose body is one of these commands is a step the user executes.

## Tests and CI

- Never make a flaky e2e test pass by working around other suites. A spec touches only workspaces it created. Forbidden fixes: suspending or hiding data from other suites, deleting rows the test didn't create, retrying on deadlock (P2034), raising timeouts to cover contention. A raised timeout is fine only for genuinely large work, with a comment saying why.
- Tests of scheduled jobs call the per-workspace method, never a handler that goes through every active workspace.
- A failure that mentions another suite, or a deadlock in cleanup, means isolation is broken: report the root cause to the user instead of patching the test.
- While developing, hand the user only the affected spec files to run; CI runs the full suite.
- Every task goes through a pull request into `master`; merging requires a green `ci` check. Never build on a red `master`.
- Branch names are `<what we're fixing>/<one or two words for what the change does>`, e.g. `test-isolation/drop-workarounds`. Never end a branch name with `/master`, and never use a bare task number as the second part.

## Context

Read before analysing, specifying or planning:

- `docs/context/preconditions.md`: agreed stack and decisions, plus open topics.
- `docs/context/legacy-analysis.md`: what the legacy system did, what is worth keeping, and its problems.

These are reference material, not a plan. Specs and plans are produced per topic.

On hold: per-task implementation guides (`docs/superpowers/guides/`). Don't write or update guides until the user lifts the hold.

## Ignored files

`docs/`, `.superpowers/`, `resources/`, `.env` and `.env.staging` are gitignored, so they don't travel with commits. Whenever an agent changes any of them, it ends its reply with this command for the user to copy and paste, with the `cd` path set to the agent's own workspace (`-n` never overwrites a file that already exists in `~/Desktop/erp-api`):

```sh
cd <this workspace's absolute path>
D=/Users/leartmekolli/Desktop/erp-api
mkdir -p "$D/docs" "$D/.superpowers" "$D/resources"
cp -Rn docs/. "$D/docs/"
cp -Rn .superpowers/. "$D/.superpowers/"
cp -Rn resources/. "$D/resources/"
cp -n .env .env.staging "$D/"
```

Show the command only; never run it.

## Progress

`docs/progress.md` holds the state of every backend module (from `docs/discovery/domain-map.md`) and an overall estimate. When a module's plan is fully done (every task committed), update that file and show the user the whole table with the new estimate, unasked. Not after single tasks.

## Legacy source

The legacy code is a read-only reference and lives outside this repo. Ask the user for its location. Never copy legacy code, names or secrets into this repo.
