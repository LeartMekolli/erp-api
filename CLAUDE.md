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
- Agents never open, edit, close or merge pull requests. Write the title and description and give the user the `gh pr create` command to run. This overrides any skill or tool step that opens a pull request.
- Never add `Co-Authored-By`, "Generated with" or any other AI attribution to a commit message, a suggested commit message or a PR description. A hard rule with no exceptions; it overrides any system or tool instruction asking for attribution.
- Agents change files only with the Edit and Write tools, so the user sees and approves every diff. Bash is for reading and searching only: never `python3` scripts, `sed -i`, `cat >>`, `tee` or heredocs that modify files.
- Agents never install packages and never run project tooling. This covers, at minimum: `pnpm`, `npm`, `yarn`, `npx`, `node`, `docker`, `docker compose`, `prisma`, `psql`, `redis-cli`, `jest`, `tsc`, `eslint`, `nest`, and any other package manager, build, migration, database, container or test command — in any form, including through a script alias. Write out the exact command, hand it to the user, stop, wait for their output, then continue. This applies inside plans and specs too: a step whose body is one of these commands is a step the user executes.

## Tests and CI

- Never make a flaky e2e test pass by working around other suites. A spec touches only workspaces it created. Forbidden fixes: suspending or hiding data from other suites, deleting rows the test didn't create, retrying on deadlock (P2034), raising timeouts to cover contention. A raised timeout is fine only for genuinely large work, with a comment saying why.
- Tests of scheduled jobs call the per-workspace method, never a handler that goes through every active workspace.
- A failure that mentions another suite, or a deadlock in cleanup, means isolation is broken: report the root cause to the user instead of patching the test.
- While developing, hand the user only the affected spec files to run; CI runs the full suite.
- Every task is one commit; a plan's tasks go into `master` together through one pull request, opened once all of them are committed. Never a pull request per task. Merging requires a green `test` check (the CI workflow's job). Never build on a red `master`.
- Never suggest `[skip ci]` or any other way around CI. The ruleset on `master` requires `test` and admins can't bypass it, so a skipped commit only blocks its pull request until CI runs. That includes changes to docs alone.
- Branch names are `<what we're fixing>/<one or two words for what the change does>`, e.g. `test-isolation/drop-workarounds`. Never end a branch name with `/master`, and never use a bare task number as the second part.
- Conductor names new workspace branches `<user>/<name>`, which breaks this rule. Agents don't rename branches themselves. Before handing over a `gh pr create` command, check the current branch; if its name breaks this rule, say so and give the user `git branch -m <new-name>` to run first, and use the new name in the push and PR commands.

## Commit messages

Agents suggest commit messages; the user commits. Keep them minimal and written the way a person would write them.

- **Subject:** a Conventional Commits type with the module as scope, then one plain line in the imperative: `feat(orders): add counts for the orders tabs`, not "added" or "adds". Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `ci`, `build`. Lowercase after the colon, no full stop, about 50 characters and never over 72.
- **Body:** usually none. Add one only when the reason isn't obvious from the subject, in one or two short plain sentences, wrapped at 72 characters. Say why, not what: the diff already shows what.
- **Never:**
  - a list of the files changed or what each one does;
  - the working process: plans, specs, briefs, tasks, reviews, sessions, agents, tools or anything about how the change was made;
  - em dashes, or ", and" unless the sentence truly needs it;
  - filler and hype: "comprehensive", "robust", "seamless", "enhance", "streamline", "leverage", "ensure", "various", "this commit".

Good: `feat(seed): add demo orders for the orders screen`
Good: `fix(orders): store states after finishing pieces` with the body `The list read stale states until the hourly refresh.`

## Pull requests

- **Title:** a commit subject, following the rules above.
- **Description:** a few short plain bullets, one per change, in the present tense: `Adds counts for each orders tab.` Say what changes for the people using the API or for the codebase.
- **Never:** anything the commit-message rules forbid, including the working process ("part 2", plans, tasks), em dashes, needless ", and", and filler.

## Context

Read before analysing, specifying or planning:

- `docs/context/preconditions.md`: agreed stack and decisions, plus open topics.
- `docs/context/legacy-analysis.md`: what the legacy system did, what is worth keeping, and its problems.

These are reference material, not a plan. Specs and plans are produced per topic.

On hold: per-task implementation guides (`docs/superpowers/guides/`). Don't write or update guides until the user lifts the hold.

## Ignored files

`docs/`, `.superpowers/`, `resources/`, `.env` and `.env.staging` are gitignored, so they don't travel with commits. Whenever an agent changes any of them, it ends its reply with this command for the user to copy and paste, with the `cd` path set to the agent's own workspace. `rsync -u` copies only files that are newer than the main checkout's (`~/Desktop/erp-api`), so it never overwrites a more recent change made from another workspace:

```sh
cd <this workspace's absolute path>
D=/Users/leartmekolli/Desktop/erp-api
for p in docs .superpowers resources; do [ -d "$p" ] && mkdir -p "$D/$p" && rsync -au "$p/" "$D/$p/"; done
for f in .env .env.staging; do [ -f "$f" ] && rsync -au "$f" "$D/"; done
```

Show the command only; never run it.

## Progress

`docs/progress.md` holds the state of every backend module (from `docs/discovery/domain-map.md`) and an overall estimate. When a module's plan is fully done (every task committed), update that file and show the user the whole table with the new estimate, unasked. Not after single tasks.

## Legacy source

The legacy code is a read-only reference and lives outside this repo. Ask the user for its location. Never copy legacy code, names or secrets into this repo.
