# patch-kit

Keeps every product on supported, patched libraries, including products with no internet access: an agent in each product, a central registry, and signed offline update bundles.

| Part | Where | Status |
|---|---|---|
| **Agent**: scans a product, makes the safe upgrades on a branch, tests them, opens a pull request; bigger upgrades become plans for a person | [`agent/`](agent/README.md) | Phase 1: working, enrolled in HR Scoring |
| **Registry**: which product runs which modules and versions, and what each needs | `registry/` (today: `modules.json`, the latest version and advisories of our own modules) | Phase 2 |
| **Offline bundles**: signed, cyclic update packages carried through the approved gateway into air-gapped sites | | Phase 3 |
| **Major upgrades**: agent-prepared branches for the plans | | Phase 4 |

The rule throughout: **the agent proposes, a person approves.** Nothing is merged or deployed by patch-kit itself.

## Releasing a module

When one of our modules (`@akil-inv/*`) ships a fix, update `registry/modules.json`: set `latest`, and add an advisory with `below: <first fixed version>` if older versions are affected. Every enrolled product's next run reports it.
