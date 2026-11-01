# ADR 091: The `core` layer and moving every area into it at once

- **Status:** accepted
- **Date:** 2026-10-31
- **Supersedes:** [ADR 069](069-architecture-reset.md) §2 on where run actions
  live and §7 on entry points

## Context

`packages/database` holds about 95,800 lines, of which about 13,300 are tables,
migrations and shared helpers. The rest is the application's service layer under
the wrong name: 87% of its exports are used only inside their own area, so
splitting flows from their queries would make hundreds of them public. Moving the
areas into a new package was approved on 2026-10-30, as one area per PR, smallest
first. `variables` went first, and a review of it measured that plan.

## Decision

**A new layer, one way only.** `apps -> core -> database, workflow-engine,
workflow-model`. Only applications may depend on `core`. `core` may use contract
types but not their runtime schemas. A module check, a project reference check and
lint refuse the reverse. `execution` folds into `core`, so run actions live there
(this replaces §2's `execution` package).

**What stays in `database` for good:** tables, migrations, transaction helpers, row
security setup, and the shared helpers for outbox, audit and idempotency. Authority
and folder scope are product rules and go to `core/src/shared/`. The flows inside
`platform` left after the one-shot move: mail and keys went to `secrets` and the rest
to `core`. Applications import only `@pertexo/database/platform`, for pools and
startup.

**`secrets` sits between `core` and `database`.** `apps -> core -> secrets ->
database`. It reads tables, so it builds on `/schema` and `/primitives` as `core`
does. `core` may use it, because three of its flows queue a sealed mail inside their
own transaction (`inbox` notice batches, `identity` email proofs, two-factor
recovery) and the insert has to share that transaction. `secrets` may not use `core`,
and `database` may not use `secrets`, even from tests: a module check, a project
reference check and lint refuse them. Its one entry point is `@pertexo/secrets/server`.
It holds system mail storage and the encryption key inventory; the rest of what the
target design names for it (key rings, safe HTTP, the mail client) is still in
`integrations`.

**One authority helper.** A core flow opens its transaction through
`withWorkspaceAccess` in `core/src/shared/`, which installs the workspace scope,
checks authority inside the transaction, honours the signal and hands the flow the
role it found.

**Named status lists.** The workspace statuses an action accepts are a constant from
`workflow-model` (`ACTIVE_`, `BROWSABLE_` or `UNPURGED_WORKSPACE_STATUSES`), and a
flow names its list once, at the helper, so two reads can't disagree.

**Entry points (this replaces §7's rule for these two packages):**

| Entry point | Who may use it | Holds |
|---|---|---|
| `@pertexo/core/<area>`, Node only | Applications | One area's door, so the imports record who uses what |
| `@pertexo/core/testing` | Tests | Test flows, which production must not be able to load |
| `@pertexo/database/schema`, `/primitives` | `core`, `secrets` | Tables and helpers; `/primitives` shrinks to the list above once the areas have moved |
| `@pertexo/secrets/server`, Node only | Applications, `core` | System mail storage and the encryption key inventory |
| `@pertexo/database/testing` | Tests | Fixtures |
| `@pertexo/database/<area>` | Applications, until that area moves | Removed as part of the move |

`core` has no root entry and no `/server`. Other packages keep the rule of at most
`@pertexo/<name>` and `@pertexo/<name>/server`. A check refuses a `/testing` door in
any `src`, a package importing itself, an application's tests importing `/schema` or
`/primitives` or reaching the database's code by relative path, and a core area
reaching into another area except as the rule below allows.

**Move every area in one mechanical PR, then one pass per area in place.** Area by
area has no order that works. Counting only runtime imports, the 17 moving areas
and `platform` form one dependency cycle, so each step leaves code behind:

| Order | Left in `database`, summed over all steps | Peak left behind | Peak exports `core` needs from `database` |
|---|---|---|---|
| Smallest first | 893 | 115 | 115 |
| Fewest callers first (not proven best) | 493 | 61 | 114 |

Either way `/primitives` grows past 100 temporary exports for most of the project,
and areas are split across two packages meanwhile. The one-shot move costs less:
after `git mv` 2,407 relative imports still resolve and a codemod rewrites 1,971.
What stays has only 23 imports into what moves (19 type-only, 4 runtime) to cut
first.

**The move leaves deep imports alone.** Of those 2,407, 688 reach into another moving
area (524 at runtime), and none goes through an `index.ts`. Measured against the real
check on a simulated tree:

| Cross-area imports after the move | Area rule errors | Runtime cycles |
|---|---|---|
| Left as they are | 688 | 0 |
| All rewritten through `<area>/index.js` | 0 | 304 |

15 of the 17 areas are one strongly connected group, so barrels turn its area cycle
into file cycles and risk startup failures from uninitialized bindings. So the area
rule is off for areas not yet passed, through an explicit list in the check that can
only shrink. A passed area's `index.ts` names its public files, and other areas
import those files directly, so no barrel edges appear. The list and this form of the
rule arrive with the move; until then `variables` and `shared` meet at `index.ts`.

## Consequences

- Until that group is broken up, loading any area in it loads them all, so an area's
  entry point doesn't narrow what a process loads. Breaking it up is real work, not
  yet priced; it belongs in the re-estimate after the first passes.
- One very large PR, safe only because it changes no logic. Branches in flight land
  first or are replayed.
- Until that PR, `variables` is the only area in `core`. What other database areas
  still call stays in `database/src/variables`, and `/primitives` carries a few
  exports marked as temporary.
- Each area's pass happens in place, with no package crossing, and no check of what
  was left behind is needed. `platform`'s flows were the one crossing, in their own
  step.
