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
and folder scope are product rules and go to `core`. The flows inside `platform`
move too: mail and keys to `secrets`, the rest to `core`. The final state is that
applications import only `@pertexo/database/platform`, for pools and startup.

**Entry points (this replaces §7's rule for these two packages):**

| Entry point | Who may use it | Holds |
|---|---|---|
| `@pertexo/core/<area>`, Node only | Applications | One area's door, so a process loads only what it uses and the imports record who uses what |
| `@pertexo/core/testing` | Tests | Test flows, which production must not be able to load |
| `@pertexo/database/schema`, `/primitives` | `core` | Tables and helpers; `/primitives` shrinks to the list above once the areas have moved |
| `@pertexo/database/testing` | Tests | Fixtures |
| `@pertexo/database/<area>` | Applications, until that area moves | Removed as part of the move |

`core` has no root entry and no `/server`. Other packages keep the rule of at most
`@pertexo/<name>` and `@pertexo/<name>/server`. A check refuses a `/testing` door in
any `src`, a package importing itself, an application's tests importing `/schema`
or `/primitives`, and a core area reaching past another area's `index.ts`.

**Move every area in one mechanical PR, then one pass per area in place.** Area by
area has no order that works. Counting only runtime imports, the 17 moving areas
and `platform` form one dependency cycle, so each step leaves code behind:

| Order | Left in `database`, summed over all steps | Peak left behind | Peak exports `core` needs from `database` |
|---|---|---|---|
| Smallest first | 893 | 115 | 115 |
| Fewest callers first (not proven best) | 493 | 61 | 114 |

Either way `/primitives` grows past 100 temporary exports for most of the project,
and areas are split across two packages meanwhile. The one-shot move costs less:
`git mv` keeps 2,407 relative imports valid and a codemod rewrites 1,971. What stays
has only 23 imports into what moves (19 type-only, 4 runtime) to cut first.

## Consequences

- One very large PR, safe only because it changes no logic. Branches in flight land
  first or are replayed.
- Until that PR, `variables` is the only area in `core`. What other database areas
  still call stays in `database/src/variables`, and `/primitives` carries a few
  exports marked as temporary.
- Each area's pass happens in place, with no package crossing, and no check of what
  was left behind is needed.
