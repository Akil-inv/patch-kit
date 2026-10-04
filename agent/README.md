# patch-kit agent

`patchkit` runs inside a product's repository. It finds packages with known
vulnerabilities, deprecated packages and runtimes past end of life, makes the
upgrades that are safe on a new branch, runs the product's own tests before and
after, and opens a pull request. Anything bigger (a new major version, a new
base image) becomes an **upgrade plan** for a person to approve. It never
pushes to the branch it started on.

## What it checks

| | How | Fixes it makes |
|---|---|---|
| npm | `npm audit` (GitHub Advisory Database), `npm view` for deprecations | `npm audit fix`, never `--force` |
| pip | `pip-audit` on a pinned `requirements.txt` (PyPI advisories) | moves a pin within the same major version; finds the parent that has to move for an indirect package |
| Container images | `FROM` lines in Dockerfiles, `image:` in docker-compose files | none: an end-of-life base image is a plan |
| OS packages in images | Trivy, when installed and `PATCHKIT_TRIVY=1` | none; reported as **not checked** otherwise |
| Our own modules | the registry's `modules.json` (latest versions and advisories for `@akil-inv/*`) | none yet: shown as an update to make |
| End of life | a built-in table (Node, Python, PostgreSQL, Apollo Server 4) | none: plans |

Below 1.0, a minor version counts as a major one (FastAPI 0.115 → 0.133 is a plan, not a safe fix).

## Enrol a product

Add `patchkit.yml` at the repository root:

```yaml
product: hr-scoring
owner: Akil-inv
environment: connected        # or air-gapped
components:
  - apps/api                  # package.json → npm
  - apps/scheduler            # requirements.txt → pip
tests:                        # run from the root, before and after the upgrades
  - name: API unit tests
    run: cd apps/api && npx jest --ci
    timeoutMinutes: 15
modules: https://raw.githubusercontent.com/Akil-inv/patch-kit/main/registry/modules.json
```

Optional: `deploy: { rollback: <how to put back the previous release> }`, `images:` (a list of Dockerfiles and compose files, if the defaults aren't right) and `modulePrefix:` (default `@akil-inv/`).

**The tests are the gate.** A test that was already failing is reported as such and doesn't block anything; a test that passed before and fails after is a regression, and then nothing is committed. A product with no tests listed still gets upgrades, and the report says nothing checked them.

## Run it

```bash
npm i -g ./akil-inv-patch-kit-agent-0.1.2.tgz   # installs with no network: its one dependency is bundled

patchkit scan                 # report only
patchkit fix                  # safe upgrades on branch patchkit/YYYY-MM-DD, tests before and after
patchkit fix --pr             # and push it and open a pull request (needs gh and GH_TOKEN)
patchkit rollback --pr        # revert the last patch-kit upgrade on a branch, test it, open a pull request
```

**A person decides.** `scan` only reports. `fix` and `rollback` change code, so they run only when a person starts them: the agent refuses them in a scheduled job (GitHub Actions `schedule`, GitLab `schedule`, or `PATCHKIT_SCHEDULED=1`). Neither ever merges anything.

**Rolling back** has two halves. On the server, the product's deploy puts back the previous release (for HR Scoring: `./deploy.sh --rollback`, automatic when a deploy check fails). In the code, `patchkit rollback` finds the newest upgrade on the branch that isn't already reverted (merge commit, squash, or the `Patch-Kit-Upgrade:` trailer every upgrade commit carries), reverts it on `patchkit/rollback-<sha>`, reinstalls, and runs the tests; if undoing it breaks a test that passes now, nothing is committed. Set `deploy.rollback` in `patchkit.yml` to have every upgrade PR say how to put back a release.

Options: `--root`, `--manifest`, `--out` (default `.patchkit/`), `--no-images`, `--allow-dirty`, `--fail-on high` (exit 2 if anything that bad is left), `-q`.

Exit codes: 0 done; 1 the upgrades (or the rollback) broke a test (nothing committed); 2 `--fail-on` threshold met; 3 the branch was made but couldn't be pushed or the PR couldn't be opened; 64 bad arguments.

`fix` refuses to start with uncommitted changes, commits only `package.json`, `package-lock.json` and `requirements.txt`, and puts back anything the tests changed.

Environment: `PATCHKIT_MODULES` (a path or URL that overrides `modules:`), `PATCHKIT_TRIVY=1`, `PATCHKIT_PIP_INSTALL=0` (don't install new pins before the tests).

## Output

`.patchkit/report.md` (also the pull request description) and `.patchkit/report.json`. The JSON is what the registry will collect (Phase 2); its `schema` is versioned and only ever gains fields.

## Develop

```bash
npm ci && npm run build
npm test                      # unit tests
PATCHKIT_E2E=1 npm test       # plus end-to-end runs against the npm registry
npm run pack:release          # → akil-inv-patch-kit-agent-<version>.tgz
```
